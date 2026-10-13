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
 *
 * ── Why the figure is an ESTIMATE, and says so ──────────────────────────────
 *
 * Everything here comes from what the provider returned to us. Three things it
 * cannot tell us:
 *
 *   1. A call that THREW returns no usage block. The prompt was sent; whether
 *      it was billed depends on where it failed (see `addUnmeasured`).
 *   2. Model calls made outside this wrapper — the Python langextract pass —
 *      report nothing back (see `addNotCounted`).
 *   3. The provider's own rounding and tier rules are not ours to reproduce.
 *
 * So the tally records what it measured, and records the gaps BY NAME beside
 * it. Nothing guessed is ever folded into the totals: a reader seeing 110k
 * tokens and "1 call timed out, not measured" knows more than one seeing a
 * confident 115k. The UI calls it an estimate and points at the provider
 * console for billed figures.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** A model that called us without naming itself — should not happen; visible if it does. */
const UNKNOWN_MODEL = 'unknown';

function emptyTally() {
  return { byModel: {}, measuredCalls: 0, unmeasured: [], notCounted: [] };
}

function emptyBucket() {
  return { promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
}

/**
 * Run `fn` with a fresh tally in scope.
 *
 * @param {Function} fn
 * @returns {Promise<*>} whatever fn returns
 */
function run(fn) {
  return storage.run(emptyTally(), fn);
}

/**
 * Add one model call's usage to the tally in scope.
 *
 * Retries add too, and deliberately: a call that was made and thrown away was
 * still paid for, and a figure that quietly excluded them would understate
 * exactly the runs worth looking at.
 *
 * Per model, because price is per model: a job that called two of them and
 * reported one number could not be priced at all without guessing which.
 *
 * @param {object} usage - the provider's usage block (Gemini `usageMetadata`)
 * @param {string} [model] - the model id the call was made against
 */
function add(usage, model) {
  const tally = storage.getStore();
  if (!tally || !usage) return;

  const key = model || UNKNOWN_MODEL;
  const bucket = tally.byModel[key] || (tally.byModel[key] = emptyBucket());

  // Gemini's names. `thoughtsTokenCount` appears on thinking models and is
  // already inside `totalTokenCount`, so it is not added to the total again —
  // it is counted as output, which is what it is and how it is billed. It is
  // ALSO kept on its own, because a run whose spend is mostly thinking is worth
  // being able to see.
  const prompt = Number(usage.promptTokenCount) || 0;
  const candidates = Number(usage.candidatesTokenCount) || 0;
  const thoughts = Number(usage.thoughtsTokenCount) || 0;
  // Cached prompt tokens are a SUBSET of promptTokenCount, not an addition to
  // it, and they bill at a lower rate. Kept separately and never added to
  // prompt, so whoever prices this subtracts rather than double-counts — the
  // mistake would inflate the figure silently and in the expensive direction.
  const cached = Number(usage.cachedContentTokenCount) || 0;
  // The provider's own total where it gave one, rather than a sum of the parts:
  // if it ever counts something we do not model, its number stays right and
  // ours would quietly drift below it.
  const total = Number(usage.totalTokenCount) || (prompt + candidates + thoughts);

  bucket.promptTokens += prompt;
  bucket.outputTokens += candidates + thoughts;
  bucket.thoughtTokens += thoughts;
  bucket.cachedTokens += cached;
  bucket.totalTokens += total;
  bucket.calls += 1;
  tally.measuredCalls += 1;
}

/**
 * Record a call we could not measure.
 *
 * A thrown call returns no usage block, so its cost is unknown — but not
 * equally unknown in every case, and flattening that into "unknown" throws away
 * the part a reader can act on:
 *
 *   - `no_response`  — never reached the model (DNS, reset, connection refused).
 *                      Nothing was inferred, so almost certainly not billed.
 *   - `rate_limited` — 429, rejected before inference. Not billed.
 *   - `server_error` — 5xx, inference did not complete. Generally not billed.
 *   - `timeout`      — the one genuinely unknown case: the prompt was fully
 *                      sent and the provider may have completed work we never
 *                      received. Possibly billed.
 *
 * `promptChars` is recorded rather than an estimated token count on purpose.
 * The character count is a fact we have; chars-to-tokens is a heuristic, and a
 * heuristic belongs where someone can see and change it, not baked into the
 * record of what happened.
 *
 * @param {{reason: string, httpStatus?: number, promptChars?: number, model?: string}} what
 */
function addUnmeasured(what = {}) {
  const tally = storage.getStore();
  if (!tally) return;
  tally.unmeasured.push({
    reason: what.reason || 'unknown',
    httpStatus: Number(what.httpStatus) || null,
    promptChars: Number(what.promptChars) || null,
    model: what.model || null
  });
}

/**
 * Name a source of spend this tally does not include at all.
 *
 * Used by callers whose model calls happen somewhere we cannot instrument —
 * today the Python langextract pass, whose library does not surface usage. The
 * point is that the module page can say "does not include the langextract
 * pass" instead of showing a total that is quietly short.
 *
 * @param {string} source
 */
function addNotCounted(source) {
  const tally = storage.getStore();
  if (!tally || !source) return;
  if (!tally.notCounted.includes(source)) tally.notCounted.push(source);
}

/**
 * The tally for the job in scope, or null outside one.
 *
 * Null rather than zeroes: "no model call was made" and "this did not run in a
 * job" are different things, and a row of zeroes on a module that never calls a
 * model would be noise on every page.
 *
 * A job that only ever failed its calls still returns a tally — measuredCalls 0
 * with the failures listed. That job spent something unknowable, and reporting
 * nothing would be the one answer that is certainly wrong.
 *
 * The flat totals are a summary of `byModel`, computed here so the three
 * readers (module panel, pipeline page, the external cost script) cannot each
 * derive them slightly differently.
 *
 * @returns {object|null}
 */
function current() {
  const tally = storage.getStore();
  if (!tally) return null;
  const models = Object.keys(tally.byModel);
  if (models.length === 0 && tally.unmeasured.length === 0 && tally.notCounted.length === 0) return null;

  let promptTokens = 0, outputTokens = 0, thoughtTokens = 0, cachedTokens = 0, totalTokens = 0, calls = 0;
  for (const key of models) {
    const b = tally.byModel[key];
    promptTokens += b.promptTokens;
    outputTokens += b.outputTokens;
    thoughtTokens += b.thoughtTokens;
    cachedTokens += b.cachedTokens;
    totalTokens += b.totalTokens;
    calls += b.calls;
  }

  return {
    byModel: JSON.parse(JSON.stringify(tally.byModel)),
    promptTokens,
    outputTokens,
    thoughtTokens,
    cachedTokens,
    // Summed from the providers' own totals. Thoughts are inside output;
    // cached is inside prompt; neither is added twice.
    totalTokens,
    calls,
    measuredCalls: tally.measuredCalls,
    unmeasured: tally.unmeasured.map(u => ({ ...u })),
    notCounted: [...tally.notCounted]
  };
}

module.exports = { run, add, addUnmeasured, addNotCounted, current, UNKNOWN_MODEL };
