/**
 * Shared Gemini call wrapper.
 *
 * Every Gemini `generateContent` call in the app goes through here so a single
 * transient failure (503 UNAVAILABLE, timeout, "high demand", network reset)
 * doesn't sink the whole pipeline stage. Previously each service issued a bare
 * `ai.models.generateContent(...)` with no retry, so a momentary outage on any
 * of datasets / protocols / materials / krt-generation / kr-comparison / DAS
 * lost that stage's entire output (observed: a comparison 503 dropped all
 * suggestions for a document; a materials timeout emptied that module).
 *
 * Two failure classes are retried:
 *  - transient TRANSPORT errors (thrown): 4xx-that-are-really-5xx, timeouts,
 *    resets — see isTransientError. Deterministic 4xx/auth errors fail fast.
 *  - "200 but empty/broken" RESPONSES (no throw): the call succeeds yet the body
 *    is empty or unparseable JSON, which yields 0 usable items downstream. Pass
 *    an `options.validate(response) => boolean`; when it returns false the call
 *    is retried, and after the last attempt the best-effort response is returned
 *    anyway (so the caller's own parser can still salvage what it can).
 *
 * Backoff is exponential with jitter so concurrent stages hitting the same
 * outage don't retry in lockstep.
 */

const { isTransientError } = require('./helpers');
const logger = require('./logger');

const DEFAULTS = { maxRetries: 4, delay: 1000, multiplier: 2, maxDelay: 15000, jitter: 400 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Call Gemini `generateContent` with retry/backoff on transient transport
 * failures and (optionally) on empty/unparseable responses.
 * @param {object} ai - a GoogleGenAI instance
 * @param {object} params - the generateContent params ({ model, contents, config })
 * @param {object} [options]
 * @param {string} [options.label='Gemini'] - stage name for log context
 * @param {(response:object)=>boolean} [options.validate] - return false to treat
 *   a (successful) response as empty/broken and retry it
 * @param {object} [options.retry] - overrides merged over the retry defaults
 * @returns {Promise<object>} the Gemini response (best-effort on the final try)
 */
async function generateContentWithRetry(ai, params, options = {}) {
  const { label = 'Gemini', validate = null, retry: retryOverrides = {} } = options;
  const cfg = { ...DEFAULTS, ...retryOverrides };

  let lastResponse = null;
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    let response = null;
    let transientError = null;
    try {
      response = await ai.models.generateContent(params);
    } catch (error) {
      // Non-transient (auth/bad-request) or last attempt → give up immediately.
      if (!isTransientError(error) || attempt === cfg.maxRetries) throw error;
      transientError = error;
    }

    if (!transientError) {
      if (!validate || validate(response)) return response;
      // 200 but empty/unparseable. Keep it as best-effort and retry.
      lastResponse = response;
      if (attempt === cfg.maxRetries) {
        logger.warn(`${label}: response still empty/unparseable after ${attempt} attempt(s) — returning best-effort`);
        return response;
      }
    }

    const backoff = Math.min(cfg.maxDelay, cfg.delay * cfg.multiplier ** (attempt - 1))
      + (cfg.jitter > 0 ? Math.floor(Math.random() * cfg.jitter) : 0);
    logger.warn(`${label}: ${transientError ? 'transient Gemini error' : 'empty/unparseable response'}, retrying`, {
      attempt, nextRetryMs: backoff, error: transientError?.message
    });
    await sleep(backoff);
  }
  return lastResponse; // not reached in practice (loop returns/throws first)
}

module.exports = { generateContentWithRetry };
