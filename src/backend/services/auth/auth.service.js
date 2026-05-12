/**
 * Authentication Service
 *
 * All session-issuing flows persist a refresh_tokens row alongside the JWT
 * pair. The raw refresh token is never stored — only sha256(token).
 *
 * The refresh flow rotates: each refresh marks the current row revoked,
 * inserts a new row, and links them via replaced_by. If a revoked token
 * is presented again, that signals compromise and we revoke the entire
 * chain for that user.
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { sequelize, User, UserTeam, RefreshToken } = require('../../models');
const jwtService = require('./jwt.service');
const auth0Service = require('./auth0.service');
const { AuthenticationError, ConflictError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// Constant bcrypt hash used to keep login response timing identical whether
// the user exists or not. Without this, a missing user returns in <5ms while
// a present user takes ~100ms (bcrypt comparison), leaking user enumeration
// over response time.
const DUMMY_PASSWORD_HASH = '$2b$12$' + 'X'.repeat(53);

/**
 * @param {string} token
 * @returns {string} hex sha256
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Persist a freshly-issued refresh token.
 * @param {string} userId
 * @param {string} rawToken
 * @param {{ip?: string, userAgent?: string}} ctx
 * @param {object} [transaction] - optional Sequelize transaction (used by refreshTokens rotation)
 * @returns {Promise<object>} the RefreshToken row
 */
async function persistRefreshToken(userId, rawToken, ctx = {}, transaction) {
  return RefreshToken.create({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt: jwtService.refreshTokenExpiryDate(),
    userAgent: ctx.userAgent || null,
    ip: ctx.ip || null
  }, transaction ? { transaction } : undefined);
}

/**
 * Issue a token pair for a user and persist the refresh token row.
 */
async function issueSession(user, ctx) {
  const tokens = jwtService.generateTokenPair(user);
  await persistRefreshToken(user.id, tokens.refreshToken, ctx);
  return tokens;
}

/**
 * Register a new user
 * @param {object} userData - User registration data
 * @param {{ip?: string, userAgent?: string}} ctx
 * @returns {Promise<{user: object, tokens: object}>}
 */
async function register(userData, ctx = {}) {
  const { email, password, name, role, team } = userData;

  const existing = await User.findOne({ where: { email: email.toLowerCase() } });
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const user = await User.create({
    email,
    passwordHash: password,
    name,
    role,
    team
  });

  const tokens = await issueSession(user, ctx);

  return {
    user: user.toJSON(),
    tokens
  };
}

/**
 * Login user
 * @param {string} email
 * @param {string} password
 * @param {{ip?: string, userAgent?: string}} ctx
 * @returns {Promise<{user: object, tokens: object}>}
 */
async function login(email, password, ctx = {}) {
  const user = await User.findOne({
    where: { email: email.toLowerCase() },
    include: [{
      model: UserTeam,
      as: 'userTeams',
      attributes: ['team']
    }]
  });

  // Always run bcrypt to keep response timing constant whether the user
  // exists or not (mitigates user enumeration via timing).
  const isValid = user
    ? await user.verifyPassword(password)
    : await bcrypt.compare(password, DUMMY_PASSWORD_HASH);

  if (!user || !isValid) {
    throw new AuthenticationError('Invalid email or password');
  }

  const tokens = await issueSession(user, ctx);

  const userData = user.toJSON();
  userData.teams = userData.userTeams ? userData.userTeams.map(ut => ut.team) : [];
  delete userData.userTeams;

  return {
    user: userData,
    tokens
  };
}

/**
 * Refresh tokens with rotation + reuse detection.
 *
 * @param {string} rawToken - the raw refresh token from the client
 * @param {{ip?: string, userAgent?: string}} ctx
 * @returns {Promise<object>} new token pair
 */
async function refreshTokens(rawToken, ctx = {}) {
  // Verify signature + expiry first (cheap, no DB hit)
  const decoded = jwtService.verifyRefreshToken(rawToken);

  const tokenHash = hashToken(rawToken);
  const record = await RefreshToken.findOne({ where: { tokenHash } });

  if (!record) {
    // Token is signed correctly but never existed in our DB — likely
    // forged or already cleaned up. Reject without leaking which.
    throw new AuthenticationError('Invalid refresh token');
  }

  if (record.revokedAt) {
    // The token was revoked. Branch on WHY:
    //
    // - revokedReason === 'logout': the user explicitly logged out and the
    //   logout already revoked all of their tokens. A replay here is most
    //   likely a stale tab on another device — benign. Reject without the
    //   alarming "session compromised" framing and without an extra wipe
    //   (the wipe already happened at logout).
    //
    // - revokedReason === 'reuse_detected': a previous request on this same
    //   chain already triggered the wipe. Same-class signal as the original
    //   reuse — the chain stays wiped. No need to re-broadcast.
    //
    // - revokedReason === 'rotation' OR null (legacy): an attacker (or buggy
    //   client) is replaying a token that was rotated out. This is the
    //   genuine compromise signal — wipe every still-live token for this
    //   user and force a full re-login.
    if (record.revokedReason === 'logout' || record.revokedReason === 'reuse_detected') {
      logger.info('Refresh rejected: token already revoked', {
        userId: record.userId,
        reason: record.revokedReason
      });
      throw new AuthenticationError('Refresh token revoked, please log in again');
    }

    await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: 'reuse_detected' },
      { where: { userId: record.userId, revokedAt: null } }
    );
    logger.warn('Refresh token reuse detected — revoking all sessions for user', {
      userId: record.userId
    });
    throw new AuthenticationError('Session compromised, please log in again');
  }

  if (record.expiresAt < new Date()) {
    throw new AuthenticationError('Refresh token expired');
  }

  if (record.userId !== decoded.userId) {
    // Defense in depth: token's userId claim doesn't match the stored row.
    throw new AuthenticationError('Invalid refresh token');
  }

  const user = await User.findByPk(record.userId);
  if (!user) {
    throw new AuthenticationError('User not found');
  }

  // Re-check Auth0 for blocked/deleted users so disable propagates within
  // the next refresh cycle (~15 min) instead of waiting for refresh
  // expiry. Defaults to ON (secure default); set
  // AUTH0_VERIFY_ON_REFRESH=false to disable. Adds 100-300ms to each
  // refresh.
  if (user.auth0Sub && process.env.AUTH0_VERIFY_ON_REFRESH !== 'false' && auth0Service.isConfigured()) {
    const blocked = await auth0Service.isUserBlocked(user.auth0Sub);
    if (blocked) {
      // Revoke the entire chain — user is no longer authorized at Auth0.
      // Tagged as 'reuse_detected' so any in-flight replay gets the same
      // "compromised" framing rather than the benign "logged out" one.
      await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: 'reuse_detected' },
        { where: { userId: user.id, revokedAt: null } }
      );
      logger.warn('Refresh blocked: Auth0 user is blocked', { userId: user.id, auth0Sub: user.auth0Sub });
      throw new AuthenticationError('Account is blocked, please contact support');
    }
  }

  // Atomically: insert the new refresh-token row AND mark the old one revoked
  // (with revoked_reason='rotation' so a future replay is correctly classified
  // as compromise, not as a benign logout-replay). If either step fails the
  // chain stays intact — no orphan new row, no half-revoked old row.
  const newTokens = jwtService.generateTokenPair(user);
  await sequelize.transaction(async (t) => {
    const newRecord = await persistRefreshToken(user.id, newTokens.refreshToken, ctx, t);
    record.revokedAt = new Date();
    record.revokedReason = 'rotation';
    record.replacedBy = newRecord.id;
    await record.save({ transaction: t });
  });

  return newTokens;
}

/**
 * Logout: revoke EVERY still-live refresh token for the user owning the
 * supplied token. Triggers a global sign-out — the user is forced to re-
 * sign-in on every device, which is the product behaviour requested
 * during audit review (2026-04-30).
 *
 * The supplied token may be presented from any device — we look it up by
 * its hash, then wipe the whole chain for that owner. If the token isn't
 * found, we no-op rather than leak existence.
 *
 * @param {string} rawToken
 * @returns {Promise<void>}
 */
async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const record = await RefreshToken.findOne({
    where: { tokenHash: hashToken(rawToken) }
  });
  if (!record) return;

  // Revoke every still-live token for this user (including the presented
  // one). Tagged 'logout' so future replays from other devices land in
  // the benign branch of the refresh handler instead of the alarming
  // "session compromised" branch.
  const [count] = await RefreshToken.update(
    { revokedAt: new Date(), revokedReason: 'logout' },
    { where: { userId: record.userId, revokedAt: null } }
  );
  logger.info('Logout: revoked all live refresh tokens for user', {
    userId: record.userId,
    revokedCount: count
  });
}

module.exports = {
  register,
  login,
  refreshTokens,
  revokeRefreshToken,
  issueSession,
  hashToken
};
