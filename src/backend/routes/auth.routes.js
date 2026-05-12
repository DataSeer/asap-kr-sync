/**
 * Authentication Routes
 *
 * Rate limiting strategy:
 * - login/register: Strict limit (10/15min) to prevent brute force
 * - refresh: Lenient limit (30/1min) to allow automatic token refresh
 * - logout/me: No rate limit (requires authentication)
 * - Auth0 routes: Strict limit (same as login)
 */

const express = require('express');
const authController = require('../controllers/auth.controller');
const { validateBody } = require('../middleware/validation.middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { authLimiter, refreshLimiter } = require('../middleware/rate-limit.middleware');

const router = express.Router();

// POST /api/auth/register - Register new user (strict rate limit)
router.post('/register',
  authLimiter,
  validateBody('register'),
  authController.register
);

// POST /api/auth/login - Login user (strict rate limit)
router.post('/login',
  authLimiter,
  validateBody('login'),
  authController.login
);

// POST /api/auth/logout - Logout user (no rate limit, requires auth)
router.post('/logout',
  authenticate,
  authController.logout
);

// POST /api/auth/refresh - Refresh access token (lenient rate limit)
router.post('/refresh',
  refreshLimiter,
  authController.refreshToken
);

// GET /api/auth/me - Get current user (no rate limit, requires auth)
router.get('/me',
  authenticate,
  authController.getCurrentUser
);

// ─── Auth0 Routes ───────────────────────────────────────────────

// GET /api/auth/auth0/status - Check if Auth0 is enabled (public)
router.get('/auth0/status',
  authController.auth0Status
);

// GET /api/auth/auth0/login?connection=google-oauth2|ORCID - Social login redirect
router.get('/auth0/login',
  authLimiter,
  authController.auth0SocialLogin
);

// POST /api/auth/auth0/login-password - Password proxy to Auth0
router.post('/auth0/login-password',
  authLimiter,
  validateBody('login'),
  authController.auth0PasswordLogin
);

// GET /api/auth/callback?code=xxx - Canonical Auth0 OAuth callback handler.
// This path is registered in the Auth0 tenant Allowed Callback URLs and MUST NOT change.
router.get('/callback',
  authController.auth0Callback
);

// Legacy alias - kept for backward compatibility with older internal callers.
router.get('/auth0/callback',
  authController.auth0Callback
);

module.exports = router;
