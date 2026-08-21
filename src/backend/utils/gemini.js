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
const tokenUsage = require('./token-usage');

const DEFAULTS = { maxRetries: 4, delay: 1000, multiplier: 2, maxDelay: 15000, jitter: 400 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Generation defaults applied to EVERY Gemini call in the app.
 *
 * `temperature: 0` — no call in this codebase had ever set a temperature, so
 * they all ran at the API default of 1.0. Every task we use Gemini for is
 * extraction, classification or judgement over a fixed document: there is one
 * right answer and sampling variety is pure noise. It measurably was noise —
 * `tmp/krt-eval-2026-08/AB-testing-results-2026-08-12.md` recorded the same
 * prompt returning 34 rows on one run and 3 on another for one manuscript, a
 * swing large enough to hide any real effect an A/B is trying to measure.
 *
 * Applied here rather than per service so a new call site cannot silently opt
 * out by forgetting it — the mistake that produced this situation. A caller
 * that genuinely wants sampling can still pass its own `config.temperature`.
 *
 * NOT set here: `thinkingConfig`. Thinking is a per-task tradeoff the detectors
 * make deliberately (see commit 38a16db), so it stays at each call site.
 */
const DEFAULT_GENERATION_CONFIG = { temperature: 0 };

/**
 * Merge the app-wide generation defaults under the caller's own config, so an
 * explicit per-call value always wins.
 * @param {object} params - generateContent params ({ model, contents, config? })
 * @returns {object} params with defaults applied
 */
function withDefaultGenerationConfig(params) {
  return {
    ...params,
    config: { ...DEFAULT_GENERATION_CONFIG, ...(params?.config || {}) }
  };
}

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
  const callParams = withDefaultGenerationConfig(params);

  let lastResponse = null;
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    let response = null;
    let transientError = null;
    try {
      response = await ai.models.generateContent(callParams);
      // Every call, including the ones a retry throws away — they were paid for.
      tokenUsage.add(response?.usageMetadata);
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

module.exports = { generateContentWithRetry, withDefaultGenerationConfig, DEFAULT_GENERATION_CONFIG };
