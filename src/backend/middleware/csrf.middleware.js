/**
 * CSRF protection — double-submit cookie pattern.
 *
 * Frontend reads `asap_kr_csrf` cookie (NOT httpOnly — JS must read it)
 * and sends its value as the `X-CSRF-Token` header on every state-changing
 * request. This middleware compares header == cookie via constant-time
 * compare. Mismatch → 403.
 *
 * Why double-submit instead of session-bound tokens? It's stateless (no
 * DB hit per request) and works alongside our existing `SameSite=Strict`
 * cookies. The `Strict` flag already prevents cross-origin requests from
 * sending the cookies; CSRF here is mostly defense-in-depth against
 * accidental same-origin XHR attacks (which would require XSS first).
 */

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE = 'asap_kr_csrf';
const CSRF_HEADER = 'x-csrf-token';

// Endpoints that issue or rotate the auth cookies don't yet have a stable
// CSRF cookie to validate against (or they're protected by other means —
// Auth0 state/nonce, refresh-cookie path scoping). Exempt them here so
// they're not blocked by the very middleware they're meant to bootstrap.
//
// Paths are mount-relative: this middleware is registered with
// `app.use('/api', csrfProtect)` in app.js, and Express strips the mount
// prefix from `req.path` inside the handler. So we compare against
// `/auth/login`, NOT `/api/auth/login`.
const EXEMPT_PATHS = new Set([
  '/auth/login',
  '/auth/auth0/login-password',
  '/auth/refresh',
  '/auth/callback',
  '/auth/auth0/callback',
  '/auth/register'
]);

/**
 * Generate a fresh CSRF token (32 random bytes, hex-encoded).
 * @returns {string} 64-char hex string
 */
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Express middleware: enforce double-submit CSRF on state-changing requests.
 */
function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.has(req.path)) return next();

  const cookieValue = req.cookies?.[CSRF_COOKIE];
  const headerValue = req.headers[CSRF_HEADER];

  if (!cookieValue || !headerValue) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  // Constant-time compare to avoid timing leaks. Buffer lengths must match.
  const cookieBuf = Buffer.from(String(cookieValue));
  const headerBuf = Buffer.from(String(headerValue));
  if (cookieBuf.length !== headerBuf.length || !crypto.timingSafeEqual(cookieBuf, headerBuf)) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }

  next();
}

module.exports = {
  csrfProtect,
  generateCsrfToken,
  CSRF_COOKIE,
  CSRF_HEADER
};
