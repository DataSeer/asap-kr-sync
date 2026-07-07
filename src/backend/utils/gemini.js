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
 * Only transient errors are retried (see isTransientError); deterministic 4xx /
 * auth / bad-request errors fail fast, unchanged. Backoff is exponential with
 * jitter so concurrent stages hitting the same outage don't retry in lockstep.
 */

const { retry, isTransientError } = require('./helpers');
const logger = require('./logger');

const DEFAULTS = { maxRetries: 4, delay: 1000, multiplier: 2, maxDelay: 15000, jitter: 400 };

/**
 * Call Gemini `generateContent` with transient-failure retry/backoff.
 * @param {object} ai - a GoogleGenAI instance
 * @param {object} params - the generateContent params ({ model, contents, config })
 * @param {object} [options]
 * @param {string} [options.label='Gemini'] - stage name for log context
 * @param {object} [options.retry] - overrides merged over the retry defaults
 * @returns {Promise<object>} the Gemini response
 */
async function generateContentWithRetry(ai, params, options = {}) {
  const { label = 'Gemini', retry: retryOverrides = {} } = options;
  return retry(() => ai.models.generateContent(params), {
    ...DEFAULTS,
    ...retryOverrides,
    shouldRetry: isTransientError,
    onRetry: (attempt, waitMs, error) => {
      logger.warn(`${label}: transient Gemini error, retrying`, {
        attempt, nextRetryMs: waitMs, error: error.message
      });
    }
  });
}

module.exports = { generateContentWithRetry };
