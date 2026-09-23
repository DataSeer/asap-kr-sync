/**
 * JWT Service
 */

const jwt = require('jsonwebtoken');
const { AuthenticationError } = require('../../utils/errors');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
// Access token lifetime: 15 minutes. It was briefly raised to one day, when
// the refresh path was where sessions died (two tabs replaying one rotated
// token, a blip at Auth0) and every death cost the user the action they had
// just taken (ASAP, 2026-09). Those causes are fixed now — the client holds a
// cross-tab lock and retries transient failures, the server tolerates a
// rotation race — so the short window is back and with it the reason for it:
// a role change, a disable or an Auth0 block takes effect within ~15 min
// instead of a day, because every refresh re-reads the user.
//
// The cost is ~32 refreshes per user per working day instead of one, so any
// residual per-refresh flakiness now shows up 32x sooner. That is deliberate:
// it is the failure mode we have hardened, and we would rather see it.
// Refresh window of 7 days keeps active users signed in across the work
// week; rotation invalidates stolen refresh tokens.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

/**
 * Generate access token
 * @param {object} user
 * @returns {string} Access token
 */
function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      // Distinguishes access from refresh tokens: both are HS256 with the
      // same secret, so without this claim a refresh token presented in the
      // session cookie would pass local verification.
      type: 'access'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
  );
}

/**
 * Generate refresh token
 * @param {object} user
 * @returns {string} Refresh token
 */
function generateRefreshToken(user) {
  return jwt.sign(
    { userId: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN, algorithm: 'HS256' }
  );
}

/**
 * Generate both access and refresh tokens
 * @param {object} user
 * @returns {object} { accessToken, refreshToken, expiresIn }
 */
function generateTokenPair(user) {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user),
    expiresIn: JWT_EXPIRES_IN
  };
}

/**
 * Verify access token
 * @param {string} token
 * @returns {object} Decoded token payload
 */
function verifyAccessToken(token) {
  try {
    // Pin HS256 to prevent algorithm-confusion attacks (never accept a token
    // whose header declares a different alg than we sign with).
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AuthenticationError('Token expired');
    }
    throw new AuthenticationError('Invalid token');
  }
}

/**
 * Verify refresh token
 * @param {string} token
 * @returns {object} Decoded token payload
 */
function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'refresh') {
      throw new AuthenticationError('Invalid refresh token');
    }
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AuthenticationError('Refresh token expired');
    }
    throw new AuthenticationError('Invalid refresh token');
  }
}

/**
 * Convert a JWT-style duration string to milliseconds.
 * Supports: Ns, Nm, Nh, Nd. Numeric input is treated as seconds (matches
 * jsonwebtoken's behavior).
 *
 * @param {string|number} duration - e.g. '15m', '30d', 3600
 * @returns {number} milliseconds
 */
function parseDurationMs(duration) {
  if (typeof duration === 'number') return duration * 1000;
  const match = /^(\d+)([smhd])$/.exec(String(duration).trim());
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}

/**
 * Compute the absolute expiry Date for a refresh token issued now.
 * Used by the persisted refresh_tokens row.
 */
function refreshTokenExpiryDate() {
  return new Date(Date.now() + parseDurationMs(JWT_REFRESH_EXPIRES_IN));
}

/**
 * Compute the absolute expiry Date for an access token issued now.
 * Used by the auth controller to size the session cookie's Max-Age.
 */
function accessTokenExpiryDate() {
  return new Date(Date.now() + parseDurationMs(JWT_EXPIRES_IN));
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
  refreshTokenExpiryDate,
  accessTokenExpiryDate,
  parseDurationMs
};
