/**
 * Authentication Controller
 */

const crypto = require('crypto');
const authService = require('../services/auth/auth.service');
const auth0Service = require('../services/auth/auth0.service');
const jwtService = require('../services/auth/jwt.service');
const { User, UserTeam } = require('../models');
const logger = require('../utils/logger');
const { ValidationError, ExternalServiceError, AuthenticationError, AuthorizationError } = require('../utils/errors');
const { generateCsrfToken, CSRF_COOKIE } = require('../middleware/csrf.middleware');

// ─── Session cookie configuration ──────────────────────────────────
//
// Three cookies carry the local JWT session (cf. tmp/auth-migration-plan.md):
//
//   asap_kr_session  — access JWT, HttpOnly, Path=/api
//   asap_kr_refresh  — refresh JWT, HttpOnly, Path=/api/auth/refresh
//   asap_kr_csrf     — CSRF double-submit token, JS-readable, Path=/
//
// Auth0 tokens are never delivered to the SPA — they're consumed server-
// side and discarded; only our local JWT pair travels in cookies.
//
// `secure` is on whenever NODE_ENV=production OR FRONTEND_URL is https.
// `sameSite=Strict` works because the SPA and API are same-origin (the
// Express app serves both `/api/*` and `dist/`). Local dev uses Vite's
// existing dev proxy so it's also same-origin.

const SECURE_COOKIES = process.env.NODE_ENV === 'production' ||
  /^https:/.test(process.env.FRONTEND_URL || '');

const SESSION_COOKIE = 'asap_kr_session';
const REFRESH_COOKIE = 'asap_kr_refresh';

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: SECURE_COOKIES,
  sameSite: 'strict',
  path: '/api'
};

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: SECURE_COOKIES,
  sameSite: 'strict',
  path: '/api/auth/refresh'
};

const CSRF_COOKIE_OPTS = {
  httpOnly: false, // JS must read it
  secure: SECURE_COOKIES,
  sameSite: 'strict',
  path: '/'
};

/**
 * Set the three auth cookies on a response. Used after every flow that
 * mints (or rotates) a local JWT pair: login, register, auth0PasswordLogin,
 * refreshToken, auth0Callback. The CSRF token is regenerated on every
 * mint so a new login invalidates whatever stale CSRF the SPA was holding.
 */
function setAuthCookies(res, tokens) {
  const accessMaxAge = jwtService.parseDurationMs(tokens.expiresIn);
  const refreshMaxAge = jwtService.refreshTokenExpiryDate().getTime() - Date.now();

  res.cookie(SESSION_COOKIE, tokens.accessToken, { ...SESSION_COOKIE_OPTS, maxAge: accessMaxAge });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...REFRESH_COOKIE_OPTS, maxAge: refreshMaxAge });
  res.cookie(CSRF_COOKIE, generateCsrfToken(), { ...CSRF_COOKIE_OPTS, maxAge: refreshMaxAge });
}

/**
 * Clear all three auth cookies. Used by logout. Each clearCookie MUST
 * match the path the cookie was set with — otherwise the browser keeps
 * the original cookie because the clear is for a different path-scope.
 */
function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: SESSION_COOKIE_OPTS.path });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_OPTS.path });
  res.clearCookie(CSRF_COOKIE, { path: CSRF_COOKIE_OPTS.path });
}

/**
 * Whether public self-service account creation is enabled.
 * Defaults to false: with the flag off, accounts can only be created by an
 * admin (POST /api/users) or by the Auth0 first-login flow.
 */
function isSelfSignupEnabled() {
  return process.env.SIGNUP_ENABLED === 'true';
}

/**
 * Cookie options for the short-lived OAuth flow cookies (state, nonce,
 * PKCE verifier). All three must survive the top-level redirect from your
 * site → Auth0 → back to your callback (~seconds), so we use sameSite='lax'
 * (which DOES travel on top-level navigations) and a 10-minute expiry.
 *
 * `secure` is on whenever FRONTEND_URL is https (covers both prod and the
 * dev EC2 host). On a local laptop without TLS, Auth0 is disabled so this
 * code path doesn't execute.
 */
const OAUTH_FLOW_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || /^https:/.test(process.env.FRONTEND_URL || ''),
  sameSite: 'lax',
  maxAge: 10 * 60 * 1000,
  path: '/api/auth'
};

const COOKIE_STATE = 'auth0_state';
const COOKIE_NONCE = 'auth0_nonce';
const COOKIE_PKCE = 'auth0_pkce';

/**
 * Generate the cryptographic material for one OAuth round trip:
 *   - state:        opaque random value, returned in callback for CSRF check
 *   - nonce:        opaque random value, returned in ID token claim
 *   - codeVerifier: random PKCE verifier kept server-side
 *   - codeChallenge: base64url(sha256(codeVerifier)), sent to Auth0
 */
function generateOAuthFlowParams() {
  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { state, nonce, codeVerifier, codeChallenge };
}

/**
 * Extract { ip, userAgent } from the request for refresh-token audit fields.
 */
function sessionContext(req) {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent']
  };
}

/**
 * Register new user
 * POST /api/auth/register
 */
async function register(req, res, next) {
  try {
    if (!isSelfSignupEnabled()) {
      logger.warn('Registration blocked: self-signup disabled', { email: req.validatedBody?.email });
      throw new AuthorizationError('Self-service account creation is disabled. Please contact an administrator.');
    }
    const userData = req.validatedBody;
    const { user, tokens } = await authService.register(userData, sessionContext(req));

    logger.info('User registered', { userId: user.id, email: user.email });

    setAuthCookies(res, tokens);
    res.status(201).json({ message: 'Registration successful', user });
  } catch (error) {
    next(error);
  }
}

/**
 * Login user
 * POST /api/auth/login
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.validatedBody;
    const { user, tokens } = await authService.login(email, password, sessionContext(req));

    logger.info('User logged in', { userId: user.id, email: user.email });

    setAuthCookies(res, tokens);
    res.json({ message: 'Login successful', user });
  } catch (error) {
    next(error);
  }
}

/**
 * Logout user
 * POST /api/auth/logout
 *
 * Revokes the supplied refresh token in our DB. For Auth0-linked users,
 * also returns the Auth0 /v2/logout URL so the frontend can redirect there
 * to terminate the Auth0 session — otherwise the user's Auth0 session
 * persists and any subsequent social-login click silently logs them
 * straight back in.
 */
async function logout(req, res, next) {
  try {
    // Read refresh token from cookie (the SPA never sees it).
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    // Logout revokes EVERY still-live refresh token for this user — see
    // auth.service.revokeRefreshToken — so signing out anywhere signs out
    // everywhere (product behaviour confirmed during audit review).
    await authService.revokeRefreshToken(refreshToken);

    logger.info('User logged out', { userId: req.userId });

    clearAuthCookies(res);

    const response = { message: 'Logout successful' };

    if (req.user?.auth0Sub && process.env.AUTH0_DOMAIN) {
      // returnTo MUST exactly match an Allowed Logout URL registered in
      // the Auth0 tenant. We register `${FRONTEND_URL}/login` for both
      // dev and prod hosts.
      response.auth0LogoutUrl = `https://${process.env.AUTH0_DOMAIN}/v2/logout?` +
        new URLSearchParams({
          client_id: process.env.AUTH0_CLIENT_ID,
          returnTo: `${process.env.FRONTEND_URL}/login`
        }).toString();
    }

    res.json(response);
  } catch (error) {
    next(error);
  }
}

/**
 * Refresh access token
 * POST /api/auth/refresh
 */
async function refreshToken(req, res, next) {
  try {
    // Refresh token lives in the httpOnly cookie scoped to this path; the
    // SPA never sees it.
    const cookieToken = req.cookies?.[REFRESH_COOKIE];
    if (!cookieToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    const tokens = await authService.refreshTokens(cookieToken, sessionContext(req));

    setAuthCookies(res, tokens);
    res.json({ message: 'Refreshed' });
  } catch (error) {
    next(error);
  }
}

/**
 * Get current user
 * GET /api/auth/me
 */
async function getCurrentUser(req, res, next) {
  try {
    res.json({ user: req.user });
  } catch (error) {
    next(error);
  }
}

// ─── Auth0 Methods ──────────────────────────────────────────────

/**
 * Find or create a local user from a verified Auth0 profile.
 *
 * Strategy:
 *   1. Find by auth0Sub (returning user) — always allowed
 *   2. New Auth0 identity with email matching a local account → link if email_verified
 *   3. Brand new user → create if email_verified
 *
 * Critical: any path that links a new Auth0 identity to an existing local
 * account (or creates a new local account from Auth0) requires
 * `email_verified === true`. Without this, an attacker who registers
 * `victim@example.com` at a social provider that doesn't enforce email
 * verification can take over the victim's local account on first login.
 *
 * After linking, the local password (if set) keeps working — coexistence preserved.
 *
 * @param {{sub: string, email: string, email_verified: boolean, name: string}} auth0Profile
 * @returns {Promise<{user: object, userData: object}>}
 */
async function findOrCreateAuth0User(auth0Profile) {
  const { sub, email, email_verified, name } = auth0Profile;

  // 1. Returning user (already linked) — trust the existing link, no email check needed.
  let user = await User.findOne({
    where: { auth0Sub: sub },
    include: [{ model: UserTeam, as: 'userTeams', attributes: ['team'] }]
  });

  if (user) {
    return buildAuth0UserResult(user);
  }

  // 2. & 3. New Auth0 identity → require verified email before linking or creating.
  if (!email_verified) {
    logger.warn('Auth0 login rejected: email not verified', { auth0Sub: sub });
    throw new AuthenticationError(
      'Your email is not verified. Please verify your email at your identity provider before signing in.'
    );
  }

  // 2. Email matches existing local account → link
  user = await User.findOne({
    where: { email: email.toLowerCase() },
    include: [{ model: UserTeam, as: 'userTeams', attributes: ['team'] }]
  });

  if (user) {
    user.auth0Sub = sub;
    if (!user.name || user.name === email.split('@')[0]) {
      user.name = name;
    }
    await user.save();
    logger.info('Linked Auth0 identity to existing user', { userId: user.id, auth0Sub: sub });
    return buildAuth0UserResult(user);
  }

  // 3. Brand new user (no local password) — fall back to the model default
  //    role (AUTHOR). Initial role assignment will move to an Auth0 claim in
  //    a follow-up; until then admins promote roles manually after first login.
  user = await User.create({
    email: email.toLowerCase(),
    name,
    auth0Sub: sub
  });

  logger.info('Created new user from Auth0', {
    userId: user.id,
    auth0Sub: sub,
    role: user.role
  });

  const userData = user.toJSON();
  userData.teams = [];
  return { user, userData };
}

/**
 * Flatten the user-with-teams Sequelize result into the standard
 * { user, userData } shape used by the auth flows.
 */
function buildAuth0UserResult(user) {
  const userData = user.toJSON();
  userData.teams = userData.userTeams ? userData.userTeams.map(ut => ut.team) : [];
  delete userData.userTeams;
  return { user, userData };
}

/**
 * Auth0 social login — redirect to Auth0 authorize URL
 * GET /api/auth/auth0/login?connection=google-oauth2
 *
 * Generates state + nonce + PKCE verifier, stores them in short-lived
 * httpOnly cookies, sends state + nonce + code_challenge to Auth0.
 */
async function auth0SocialLogin(req, res, next) {
  try {
    const { connection } = req.query;
    if (!connection) {
      throw new ValidationError('Connection parameter is required');
    }

    if (!auth0Service.isEnabled()) {
      throw new ExternalServiceError('Auth0', 'Authentication is not available');
    }

    const { state, nonce, codeVerifier, codeChallenge } = generateOAuthFlowParams();

    res.cookie(COOKIE_STATE, state, OAUTH_FLOW_COOKIE_OPTS);
    res.cookie(COOKIE_NONCE, nonce, OAUTH_FLOW_COOKIE_OPTS);
    res.cookie(COOKIE_PKCE, codeVerifier, OAUTH_FLOW_COOKIE_OPTS);

    const loginUrl = auth0Service.getLoginUrl(connection, { state, nonce, codeChallenge });
    res.redirect(loginUrl);
  } catch (error) {
    next(error);
  }
}

/**
 * Auth0 password login — proxy credentials to Auth0
 * POST /api/auth/auth0/login-password
 */
async function auth0PasswordLogin(req, res, next) {
  try {
    const { email, password } = req.validatedBody;

    if (!auth0Service.isEnabled()) {
      throw new ExternalServiceError('Auth0', 'Authentication is not available');
    }

    // Authenticate with Auth0
    const auth0Tokens = await auth0Service.passwordLogin(email, password);

    // Verify ID token signature via JWKS and extract user profile
    const auth0Profile = await auth0Service.verifyIdToken(auth0Tokens.idToken);

    // Find or create local user
    const { user, userData } = await findOrCreateAuth0User(auth0Profile);

    // Generate local JWT tokens and persist refresh-token row
    const tokens = await authService.issueSession(user, sessionContext(req));

    logger.info('Auth0 password login successful', { userId: user.id });

    setAuthCookies(res, tokens);
    res.json({ message: 'Login successful', user: userData });
  } catch (error) {
    next(error);
  }
}

/**
 * Auth0 OAuth callback — exchange code, find/create user, redirect to frontend.
 * GET /api/auth/auth0/callback?code=xxx&state=xxx
 *
 * Validates state (CSRF), exchanges code with PKCE verifier, verifies ID
 * token signature + nonce, then issues a local JWT pair.
 */
async function auth0Callback(req, res, _next) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  // Always clear the flow cookies once the callback fires — they are
  // single-use and continuing to hold them would block a fresh login attempt.
  const clearFlowCookies = () => {
    res.clearCookie(COOKIE_STATE, { path: '/api/auth' });
    res.clearCookie(COOKIE_NONCE, { path: '/api/auth' });
    res.clearCookie(COOKIE_PKCE, { path: '/api/auth' });
  };

  try {
    const { code, state, error: auth0Error, error_description } = req.query;

    if (auth0Error) {
      clearFlowCookies();
      logger.error('Auth0 callback error', { error: auth0Error, description: error_description });
      // Map upstream errors to known codes the frontend can render safely.
      return res.redirect(`${frontendUrl}/login?error=unauthorized`);
    }

    if (!code) {
      clearFlowCookies();
      return res.redirect(`${frontendUrl}/login?error=unauthorized`);
    }

    // CSRF: state in callback must match the one we set at login start.
    const expectedState = req.cookies?.[COOKIE_STATE];
    if (!state || !expectedState || state !== expectedState) {
      clearFlowCookies();
      logger.warn('Auth0 callback rejected: state mismatch');
      return res.redirect(`${frontendUrl}/login?error=invalid_state`);
    }

    const codeVerifier = req.cookies?.[COOKIE_PKCE];
    if (!codeVerifier) {
      clearFlowCookies();
      logger.warn('Auth0 callback rejected: missing PKCE verifier cookie');
      return res.redirect(`${frontendUrl}/login?error=invalid_state`);
    }

    const expectedNonce = req.cookies?.[COOKIE_NONCE];

    // Exchange code for tokens (PKCE-protected)
    const auth0Tokens = await auth0Service.exchangeCodeForTokens(code, codeVerifier);

    // Verify ID token signature via JWKS and extract user profile
    const auth0Profile = await auth0Service.verifyIdToken(auth0Tokens.idToken);

    // Verify nonce in ID token matches what we set at login start
    if (!expectedNonce || auth0Profile.nonce !== expectedNonce) {
      clearFlowCookies();
      logger.warn('Auth0 callback rejected: nonce mismatch');
      return res.redirect(`${frontendUrl}/login?error=invalid_nonce`);
    }

    // Find or create local user (rejects unverified emails)
    const { user, userData } = await findOrCreateAuth0User(auth0Profile);

    // Generate local JWT tokens and persist refresh-token row
    const tokens = await authService.issueSession(user, sessionContext(req));

    clearFlowCookies();

    logger.info('Auth0 callback login successful', { userId: user.id });

    // Set the local-JWT session cookies on the redirect response and
    // redirect to a clean URL — no tokens in window.location.hash, never
    // recorded in browser history. Auth0 application config (allowed
    // callback URLs, grant types, audience) is unchanged; this is purely
    // a backend→SPA delivery refinement.
    //
    // Per the integration guide (`tmp/dataseer-asap-auth0-technical-guide.pdf`)
    // userData is also discarded — Auth0 access/ID tokens are never
    // surfaced to the SPA. The SPA fetches `GET /api/auth/me` on mount
    // to repopulate the user profile.
    void userData;
    setAuthCookies(res, tokens);
    res.redirect(`${frontendUrl}/dashboard`);
  } catch (error) {
    clearFlowCookies();
    logger.error('Auth0 callback processing failed', { error: error.message });
    res.redirect(`${frontendUrl}/login?error=unauthorized`);
  }
}

/**
 * Get Auth0 availability status
 * GET /api/auth/auth0/status
 */
function auth0Status(req, res) {
  res.json({ enabled: auth0Service.isEnabled() });
}

module.exports = {
  register,
  login,
  logout,
  refreshToken,
  getCurrentUser,
  auth0SocialLogin,
  auth0PasswordLogin,
  auth0Callback,
  auth0Status
};
