/**
 * What a run spent, in tokens.
 *
 * The panel could say how long a run took and what it found, but not what it
 * cost — nothing captured the provider's usage figures, so "is this module
 * expensive?" had no answer anywhere in the system.
 *
 * ── Why an ambient store rather than a return value ─────────────────────────
 *
 * Nine services call the model, most of them several times per run, through one
 * shared wrapper. Threading a tally back out of each would mean touching every
 * service and every meta object they build, and the next service added would
 * silently not report — the failure being an absence, which is the kind nobody
 * notices.
 *
 * `AsyncLocalStorage` gives each JOB its own tally without any of that: the
 * queue wraps a handler in `run()`, every model call underneath adds to
 * whatever tally is active, and the job's own result reads it back. Concurrent
 * workers cannot see each other's — that is the whole point of the store, and
 * the reason a module-level counter would have been wrong.
 *
 * Outside a job there is no store, and `add()` is a no-op rather than an error:
 * a script or a test calling the model is not a run and has nothing to charge.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with a fresh tally in scope.
 *
 * @param {Function} fn
 * @returns {Promise<*>} whatever fn returns
 */
function run(fn) {
  return storage.run({ promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 }, fn);
}

/**
 * Add one model call's usage to the tally in scope.
 *
 * Retries add too, and deliberately: a call that was made and thrown away was
 * still paid for, and a figure that quietly excluded them would understate
 * exactly the runs worth looking at.
 *
 * @param {object} usage - the provider's usage block (Gemini `usageMetadata`)
 */
function add(usage) {
  const tally = storage.getStore();
  if (!tally || !usage) return;

  // Gemini's names. `thoughtsTokenCount` appears on thinking models and is
  // already inside `totalTokenCount`, so it is not added again — it is counted
  // as output, which is what it is.
  const prompt = Number(usage.promptTokenCount) || 0;
  const candidates = Number(usage.candidatesTokenCount) || 0;
  const thoughts = Number(usage.thoughtsTokenCount) || 0;
  const total = Number(usage.totalTokenCount) || (prompt + candidates + thoughts);

  tally.promptTokens += prompt;
  tally.outputTokens += candidates + thoughts;
  tally.totalTokens += total;
  tally.calls += 1;
}

/**
 * The tally for the job in scope, or null outside one.
 *
 * Null rather than zeroes: "no model call was made" and "this did not run in a
 * job" are different things, and a row of zeroes on a module that never calls a
 * model would be noise on every page.
 *
 * @returns {{promptTokens: number, outputTokens: number, totalTokens: number, calls: number}|null}
 */
function current() {
  const tally = storage.getStore();
  if (!tally || tally.calls === 0) return null;
  return { ...tally };
}

module.exports = { run, add, current };
