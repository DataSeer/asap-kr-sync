/**
 * Rate Limiting Middleware
 *
 * Strategy:
 * - Auth endpoints (login/register): strict per-IP limit (prevent brute force)
 * - API baseline: per-IP limit on the whole /api surface. It is mounted in
 *   app.js BEFORE router-level authenticate, so req.user is never set here
 *   and the limit applies to everyone, authenticated or not.
 * - Upload/LM API: stricter per-user limits on top of the baseline for
 *   expensive operations (storage, LM analysis, detection jobs)
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
    keyGenerator = null
  } = options;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
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
 * API rate limiter - baseline per-IP DoS protection for the whole /api surface
 * (mounted before authenticate, so it keys by IP for everyone)
 */
const apiLimiter = createRateLimiter({
  ...RATE_LIMITS.api
});

/**
 * Auth rate limiter - ALWAYS applies (prevent brute force attacks)
 * Strict: 10 attempts per 15 minutes per IP
 */
const authLimiter = createRateLimiter({
  ...RATE_LIMITS.auth,
  keyGenerator: (req) => `ip:${req.ip}` // Always use IP for auth (no user yet)
});

/**
 * Upload rate limiter - applies per user
 * Prevents abuse of storage resources
 */
const uploadLimiter = createRateLimiter({
  ...RATE_LIMITS.upload
});

/**
 * LM API rate limiter - applies per user, shared across every route that
 * spawns LM/detection/conversion work (Gemini calls, Python subprocesses,
 * LibreOffice). One budget for all of them: these jobs are expensive, and a
 * user has no legitimate reason to trigger more than a handful per minute.
 */
const lmApiLimiter = createRateLimiter({
  ...RATE_LIMITS.lmApi
});

/**
 * The DAILY budget for starting analysis work, per user and per role.
 *
 * The per-minute limiter above stops bursts; this one is the actual policy.
 * Re-running a module is available to everyone who can reach the submission —
 * an author who can see a wrong result is exactly the person who should be able
 * to ask for it again — so what separates the roles is a budget, not a button.
 *
 *   author        10 runs/day    their own manuscripts
 *   asap_pm       50 runs/day    a lab's worth
 *   ds_annotator  unlimited      curation is the job
 *   admin         unlimited
 *
 * **One request is one run.** Starting the whole pipeline and re-running a
 * single module both cost 1: the first queues eleven jobs from one request, so
 * counting requests is generous to the common case and simple to explain. A
 * limit a user cannot predict is a limit they experience as a fault.
 *
 * `max: 0` means unlimited here — express-rate-limit treats 0 as "block
 * everything", so those roles are skipped outright instead.
 *
 * Configured in `conf/rate-limits.json` under `lmApiDaily`.
 */
const DAILY_LIMITS = RATE_LIMITS.lmApiDaily?.max || {};

/** The role's daily allowance, or 0 for unlimited. */
function dailyLimitFor(req) {
  const role = req.user?.role;
  return Number(DAILY_LIMITS[role] ?? 0);
}

const lmApiDailyLimiter = createRateLimiter({
  windowMs: RATE_LIMITS.lmApiDaily?.windowMs ?? 24 * 60 * 60 * 1000,
  message: RATE_LIMITS.lmApiDaily?.message
    || 'You have reached your daily limit for starting analyses.',
  // Per role, read at request time — a promotion takes effect immediately
  // rather than at the next restart.
  max: (req) => dailyLimitFor(req) || Number.MAX_SAFE_INTEGER,
  // Unlimited roles are not merely given a huge number: skipping keeps their
  // requests out of the store entirely.
  skip: (req) => dailyLimitFor(req) === 0
});

/**
 * Token refresh rate limiter - more lenient than login/register
 * Allows automatic token refresh without blocking legitimate users
 */
const refreshLimiter = createRateLimiter({
  ...RATE_LIMITS.refresh,
  keyGenerator: (req) => `ip:${req.ip}` // Use IP for refresh
});

module.exports = {
  createRateLimiter,
  apiLimiter,
  authLimiter,
  refreshLimiter,
  uploadLimiter,
  lmApiLimiter,
  lmApiDailyLimiter,
  dailyLimitFor
};
