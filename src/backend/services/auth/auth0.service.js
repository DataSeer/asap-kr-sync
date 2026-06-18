/**
 * Auth0 Service
 * Handles all Auth0 communication (server-side identity bridge)
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');
const logger = require('../../utils/logger');
const { AuthenticationError, ExternalServiceError } = require('../../utils/errors');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Canonical OAuth redirect URI. Auth0 enforces strict matching between the
// authorize-time redirect_uri and the token-exchange redirect_uri, so both
// must reference this same constant.
const REDIRECT_URI = `${API_BASE_URL}/api/auth/callback`;

let jwksClient = null;

/**
 * Get or create the JWKS client (lazy initialization)
 * @returns {jwksRsa.JwksClient}
 */
function getJwksClient() {
  if (!jwksClient) {
    jwksClient = jwksRsa({
      jwksUri: `https://${AUTH0_DOMAIN}/.well-known/jwks.json`,
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5
    });
  }
  return jwksClient;
}

/**
 * Build Auth0 authorize URL with state, nonce, and PKCE.
 *
 * @param {string} connection - Auth0 connection name (e.g., 'google-oauth2', 'ORCID')
 * @param {{state: string, nonce: string, codeChallenge: string}} flowParams
 *   - state: random value the callback must echo back (CSRF protection on OAuth flow)
 *   - nonce: random value Auth0 will echo in the ID token's `nonce` claim
 *     (ID token replay protection)
 *   - codeChallenge: base64url(sha256(codeVerifier)) — PKCE proof that the
 *     same client that initiated the flow is exchanging the code
 * @returns {string} Auth0 authorize URL
 */
function getLoginUrl(connection, { state, nonce, codeChallenge }) {
  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID) {
    throw new ExternalServiceError('Auth0 is not configured');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: AUTH0_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    connection,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  if (AUTH0_AUDIENCE) {
    params.set('audience', AUTH0_AUDIENCE);
  }

  return `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 *
 * @param {string} code - Authorization code from Auth0 callback
 * @param {string} codeVerifier - The PKCE verifier matching the challenge
 *   sent at authorize time. Auth0 hashes it and compares against the
 *   recorded code_challenge.
 * @returns {Promise<{accessToken: string, idToken: string}>}
 */
async function exchangeCodeForTokens(code, codeVerifier) {
  try {
    const response = await axios.post(`https://${AUTH0_DOMAIN}/oauth/token`, {
      grant_type: 'authorization_code',
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI
    });

    return {
      accessToken: response.data.access_token,
      idToken: response.data.id_token
    };
  } catch (error) {
    logger.error('Auth0 code exchange failed', {
      status: error.response?.status,
      error: error.response?.data?.error_description || error.message
    });
    throw new ExternalServiceError('Failed to exchange authorization code');
  }
}

/**
 * Proxy password login through Auth0 (Resource Owner Password Grant)
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<{accessToken: string, idToken: string}>}
 */
async function passwordLogin(email, password) {
  try {
    const response = await axios.post(`https://${AUTH0_DOMAIN}/oauth/token`, {
      grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      username: email,
      password,
      realm: 'Username-Password-Authentication',
      scope: 'openid profile email',
      audience: AUTH0_AUDIENCE
    });

    return {
      accessToken: response.data.access_token,
      idToken: response.data.id_token
    };
  } catch (error) {
    logger.error('Auth0 password login failed', {
      email: maskEmail(email),
      status: error.response?.status,
      error: error.response?.data?.error_description || error.message
    });

    if (error.response?.status === 403 || error.response?.status === 401) {
      throw new AuthenticationError('Invalid email or password');
    }
    throw new ExternalServiceError('Auth0 authentication failed');
  }
}

/**
 * Mask an email for logging (avoid leaking PII in plaintext logs).
 * "alice@example.com" -> "al***@example.com"
 */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '<invalid>';
  return email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2');
}

// Standard OIDC claims that carry PII — masked in the debug view below.
const PII_CLAIM_KEYS = new Set([
  'name', 'given_name', 'family_name', 'middle_name', 'nickname',
  'preferred_username', 'profile', 'picture', 'website', 'gender',
  'birthdate', 'phone_number', 'address'
]);

/**
 * Build a log-safe view of ID-token claims for debugging the Auth0 integration
 * — e.g. discovering which custom/namespaced claim carries the user's role and
 * what shape it has (string vs array vs object). Known PII claims are masked;
 * every other key — including custom namespaced claims like
 * `https://your-app/roles` — is shown in full so field names and structure are
 * visible without leaking PII to the logs.
 * @param {object} claims - verified ID-token payload
 * @returns {object} redacted copy safe to log
 */
function redactClaims(claims) {
  if (!claims || typeof claims !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(claims)) {
    if (key === 'email') out[key] = maskEmail(value);
    else if (key === 'sub') out[key] = typeof value === 'string' ? `${value.slice(0, 8)}***` : '[redacted]';
    else if (PII_CLAIM_KEYS.has(key)) out[key] = '[redacted]';
    else out[key] = value; // non-PII / custom claims (e.g. role) shown in full
  }
  return out;
}

/**
 * Verify and decode an Auth0 ID token using JWKS.
 *
 * Critical: this validates the signature, issuer, audience, and expiry. The
 * old jwt.decode() path trusted whatever claims appeared in the token,
 * which would let a tampered token impersonate any user.
 *
 * @param {string} idToken - Auth0 ID token
 * @returns {Promise<{sub: string, email: string, email_verified: boolean, name: string, nonce: string|undefined}>}
 */
async function verifyIdToken(idToken) {
  const client = getJwksClient();
  const decodedHeader = jwt.decode(idToken, { complete: true });
  if (!decodedHeader) {
    throw new AuthenticationError('Invalid ID token format');
  }

  let verified;
  try {
    const key = await client.getSigningKey(decodedHeader.header.kid);
    verified = jwt.verify(idToken, key.getPublicKey(), {
      algorithms: ['RS256'],
      // ID tokens use the client_id as audience (different from API access
      // tokens which use AUTH0_AUDIENCE).
      audience: AUTH0_CLIENT_ID,
      issuer: `https://${AUTH0_DOMAIN}/`
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AuthenticationError('ID token expired');
    }
    logger.debug('Auth0 ID token verification failed', { error: error.message });
    throw new AuthenticationError('Invalid ID token');
  }

  // Opt-in claim debugging. Set AUTH0_DEBUG_CLAIMS=true to log the ID-token
  // claim names + values with PII masked — use this to discover which custom
  // claim Auth0 sends the role in (e.g. a namespaced `https://app/roles`) and
  // its shape. Never logs raw email/name/sub, so it is safe to enable
  // temporarily in any environment. Defaults off.
  if (process.env.AUTH0_DEBUG_CLAIMS === 'true') {
    logger.info('Auth0 ID token claims (PII-redacted)', {
      keys: Object.keys(verified),
      claims: redactClaims(verified)
    });
  }

  return {
    sub: verified.sub,
    email: verified.email,
    email_verified: verified.email_verified === true,
    name: verified.name || verified.nickname || verified.email?.split('@')[0],
    nonce: verified.nonce
  };
}

/**
 * Verify an Auth0 access token using JWKS
 * @param {string} token - Auth0 access token
 * @returns {Promise<object>} Decoded and verified token payload
 */
async function verifyAccessToken(token) {
  const client = getJwksClient();

  // Decode header to get the key ID
  const decodedHeader = jwt.decode(token, { complete: true });
  if (!decodedHeader) {
    throw new AuthenticationError('Invalid token format');
  }

  try {
    const key = await client.getSigningKey(decodedHeader.header.kid);
    const signingKey = key.getPublicKey();

    const verified = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
      audience: AUTH0_AUDIENCE,
      issuer: `https://${AUTH0_DOMAIN}/`
    });

    return verified;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AuthenticationError('Token expired');
    }
    logger.debug('Auth0 token verification failed', { error: error.message });
    throw new AuthenticationError('Invalid token');
  }
}

/**
 * Check if Auth0 is configured (credentials present)
 * @returns {boolean}
 */
function isConfigured() {
  return !!(AUTH0_DOMAIN && AUTH0_CLIENT_ID && AUTH0_CLIENT_SECRET);
}

// ── Management API (opt-in user freshness check) ─────────────────

let managementToken = null;
let managementTokenExpiresAt = 0;

/**
 * Get a (cached) Management API access token using client credentials.
 * Auth0 issues these for the special audience https://${DOMAIN}/api/v2/.
 *
 * The Management API client (this Auth0 application) must be authorized
 * for that API and granted the `read:users` scope.
 *
 * @returns {Promise<string>}
 */
async function getManagementToken() {
  if (managementToken && Date.now() < managementTokenExpiresAt - 60_000) {
    return managementToken;
  }
  const response = await axios.post(`https://${AUTH0_DOMAIN}/oauth/token`, {
    grant_type: 'client_credentials',
    client_id: AUTH0_CLIENT_ID,
    client_secret: AUTH0_CLIENT_SECRET,
    audience: `https://${AUTH0_DOMAIN}/api/v2/`
  });
  managementToken = response.data.access_token;
  managementTokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
  return managementToken;
}

/**
 * Check whether an Auth0 user is currently blocked. Used during refresh
 * to propagate Auth0-side disable/block actions within ~15 minutes (next
 * silent refresh) instead of waiting for the refresh token to expire
 * naturally.
 *
 * Enabled by default; set AUTH0_VERIFY_ON_REFRESH=false to skip the check
 * (saves 100-300ms per refresh at the cost of delayed block propagation).
 *
 * @param {string} sub - Auth0 user identifier (e.g. "google-oauth2|123")
 * @returns {Promise<boolean>} true if the user is blocked at Auth0
 */
async function isUserBlocked(sub) {
  const token = await getManagementToken();
  try {
    const response = await axios.get(
      `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(sub)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000
      }
    );
    // user.blocked is undefined for non-blocked users.
    return response.data?.blocked === true;
  } catch (err) {
    if (err.response?.status === 404) {
      // User no longer exists at Auth0 — treat as blocked.
      return true;
    }
    // Network/auth errors: do NOT block the refresh. Log and let it through.
    logger.warn('Auth0 user freshness check failed', {
      sub,
      status: err.response?.status,
      error: err.message
    });
    return false;
  }
}

/**
 * Check if Auth0 is enabled (feature flag + configured)
 * @returns {boolean}
 */
function isEnabled() {
  const flag = process.env.AUTH0_ENABLED;
  return isConfigured() && flag === 'true';
}

module.exports = {
  getLoginUrl,
  exchangeCodeForTokens,
  passwordLogin,
  verifyIdToken,
  verifyAccessToken,
  isConfigured,
  isEnabled,
  isUserBlocked
};
