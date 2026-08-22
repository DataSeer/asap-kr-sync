/**
 * Every try, at both layers, kept.
 *
 * `retryCount: 2` with one overwritten error message cannot answer *"the first
 * two attempts returned 529, then it succeeded"* — and that is the difference
 * between an upstream that is flaky and one that is broken, which is the whole
 * question somebody looking at a slow run is trying to settle.
 *
 * ── Two layers, one list ────────────────────────────────────────────────────
 *
 *   queue   pg-boss re-delivering the job. Counted today, and nothing else.
 *   client  the shared retry helper and the Gemini wrapper, retrying a single
 *           HTTP call inside one delivery. Not recorded at all.
 *
 * Both go in one array on the execution, tagged with `layer` and grouped by
 * `delivery`, because reading them apart is exactly what makes a run hard to
 * understand: "it was retried twice" means two very different things depending
 * on which layer did the retrying, and the interesting runs are the ones where
 * both did.
 *
 * ── Why an ambient store ────────────────────────────────────────────────────
 *
 * The same reason as token-usage, which this deliberately mirrors: the retries
 * happen four layers below the code that writes the execution row, in helpers
 * shared by nine services. Threading a list back out would mean touching every
 * one of them, and the next service added would silently not report — a failure
 * that is an absence, which is the kind nobody notices.
 *
 * The store's lifetime is ONE DELIVERY, so entries are drained onto the
 * execution when the delivery ends and appended to what is already there. A
 * pg-boss retry starts a fresh store and adds to the same execution, which is
 * correct: a re-delivery is another attempt at the same execution, not a new
 * one.
 *
 * Outside a job there is no store and `add()` is a no-op, so a script or a test
 * calling the same helper records nothing rather than throwing.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * How many entries one execution may accumulate.
 *
 * A bound rather than a belief that it will never be reached: this is written
 * from a retry loop, and an execution whose record is a megabyte of identical
 * timeouts is unreadable in exactly the situation it was kept for. The cap is
 * far above any healthy run, and being hit is itself a finding.
 */
const MAX_ATTEMPTS = 200;

/**
 * Run `fn` with a fresh attempt list in scope.
 *
 * @param {Function} fn
 * @returns {Promise<*>} whatever fn returns
 */
function run(fn) {
  return storage.run([], fn);
}

/**
 * The HTTP status behind an error, across the shapes this codebase sees.
 *
 * Axios puts it on `response.status`, the Google GenAI client on `status` or
 * inside the message, and a bare Error has none. `code` is deliberately not
 * consulted: on a network error it is a string like ECONNRESET, and coercing
 * that to a number yields NaN dressed up as a status.
 *
 * @param {*} error
 * @returns {number|null}
 */
function httpStatusOf(error) {
  if (!error) return null;
  const raw = error.status ?? error.statusCode ?? error?.response?.status;
  const status = Number(raw);
  if (Number.isInteger(status) && status >= 100 && status < 600) return status;
  // Google's client often carries the code only inside the message body.
  const match = String(error.message || '').match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Record one try.
 *
 * @param {object} attempt
 * @param {string} attempt.layer - 'client' | 'queue'
 * @param {boolean} attempt.ok
 * @param {string} [attempt.engine] - which service was called
 * @param {*} [attempt.error] - an Error or a message
 * @param {number} [attempt.httpStatus] - derived from `error` when absent
 */
function add({ layer = 'client', ok = false, engine = null, error = null, httpStatus } = {}) {
  const attempts = storage.getStore();
  if (!attempts) return;
  if (attempts.length >= MAX_ATTEMPTS) return;

  attempts.push({
    at: new Date().toISOString(),
    layer,
    ok: !!ok,
    engine,
    error: error ? String(error.message || error).slice(0, 500) : null,
    httpStatus: httpStatus ?? httpStatusOf(error)
  });
}

/**
 * Take what has been recorded and clear the list.
 *
 * Draining rather than reading matters: `markRetrying` and then `markFailed`
 * can both fire within one delivery, and a peek would write the same attempts
 * onto the execution twice.
 *
 * @returns {object[]}
 */
function drain() {
  const attempts = storage.getStore();
  if (!attempts?.length) return [];
  return attempts.splice(0, attempts.length);
}

/** What has been recorded so far, without clearing it. @returns {object[]} */
function current() {
  return [...(storage.getStore() || [])];
}

module.exports = { run, add, drain, current, httpStatusOf, MAX_ATTEMPTS };
