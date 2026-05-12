/**
 * Rate Limiting Middleware
 *
 * Strategy:
 * - Auth endpoints (login/register): Always rate limited (prevent brute force)
 * - API endpoints: Skip rate limiting for authenticated users
 * - Upload/LM API: Rate limited per user for resource protection
 */

const rateLimit = require('express-rate-limit');
const { RateLimitError } = require('../utils/errors');
const { RATE_LIMITS } = require('../config/constants');

/**
 * Create a custom rate limiter
 * @param {object} options - Rate limit options
 * @returns {Function} Rate limit middleware
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes default
    max = 100,
    message = 'Too many requests, please try again later',
    skipSuccessfulRequests = false,
    skipIfAuthenticated = false,
    keyGenerator = null
  } = options;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    // Skip rate limiting if user is authenticated (when skipIfAuthenticated is true)
    skip: skipIfAuthenticated ? (req) => !!req.user : () => false,
    // Use user ID for authenticated users, IP for unauthenticated
    keyGenerator: keyGenerator || ((req) => {
      if (req.user?.id) {
        return `user:${req.user.id}`;
      }
      return `ip:${req.ip}`;
    }),
    handler: (req, res, next) => {
      next(new RateLimitError(message));
    }
  });
}

/**
 * API rate limiter - skips for authenticated users
 * Unauthenticated users get limited to prevent abuse
 */
const apiLimiter = createRateLimiter({
  ...RATE_LIMITS.api,
  skipIfAuthenticated: true // Authenticated users are not rate limited on API
});

/**
 * Auth rate limiter - ALWAYS applies (prevent brute force attacks)
 * Strict: 10 attempts per 15 minutes per IP
 */
const authLimiter = createRateLimiter({
  ...RATE_LIMITS.auth,
  skipIfAuthenticated: false, // Always rate limit auth endpoints
  keyGenerator: (req) => `ip:${req.ip}` // Always use IP for auth (no user yet)
});

/**
 * Upload rate limiter - applies per user
 * Prevents abuse of storage resources
 */
const uploadLimiter = createRateLimiter({
  ...RATE_LIMITS.upload,
  skipIfAuthenticated: false // Keep limits but use user-based key
});

/**
 * LM API rate limiter - applies per user
 * Protects expensive AI analysis operations
 */
const lmApiLimiter = createRateLimiter({
  ...RATE_LIMITS.lmApi,
  skipIfAuthenticated: false // Keep limits but use user-based key
});

/**
 * Token refresh rate limiter - more lenient than login/register
 * Allows automatic token refresh without blocking legitimate users
 */
const refreshLimiter = createRateLimiter({
  ...RATE_LIMITS.refresh,
  skipIfAuthenticated: false,
  keyGenerator: (req) => `ip:${req.ip}` // Use IP for refresh
});

module.exports = {
  createRateLimiter,
  apiLimiter,
  authLimiter,
  refreshLimiter,
  uploadLimiter,
  lmApiLimiter
};
