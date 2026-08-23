/**
 * Running a step with a past run's parameters instead of today's.
 *
 * A restart already uses frozen INPUTS — the manuscript and KRT the round
 * settled on. It uses today's prompt and today's model, which means a re-run
 * that disagrees with the original cannot be told apart from a prompt somebody
 * edited in between. This is the other half: "run it as it ran".
 *
 * ── Why an ambient store ────────────────────────────────────────────────────
 *
 * The same reason as token-usage and attempt-log, which this deliberately
 * mirrors. The model is read where the client is called, four layers below the
 * orchestrator that knows which mode the run is in; the prompt is read from a
 * per-service loader. Threading a flag to both, in twelve services, is twelve
 * chances to miss one — and a service that missed it would quietly run with
 * today's prompt while the UI said the run was reproduced.
 *
 * Outside a frozen restart there is no store, and every resolver returns what
 * it was given. That is the normal path: nothing changes for a live run.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It cannot pin the external service's own version. `gemini-2.5-flash` is an
 * alias, and Modal's docling image moves. Recording what we asked for is the
 * most any of this can promise, and the UI has to say so rather than claim a
 * faithful reproduction.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { mergeFrozen } = require('../services/queue/run-inputs.service');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with a past execution's parameters in scope.
 *
 * @param {object|null} frozen - `{ call, promptText }` from a run's inputs
 *   artefact. Null or undefined runs `fn` with nothing in scope, which is the
 *   live path — so a caller need not branch.
 * @param {Function} fn
 * @returns {Promise<*>}
 */
function run(frozen, fn) {
  if (!frozen || (!frozen.call && !frozen.promptText)) return fn();
  return storage.run({ ...frozen, restored: [], ignored: [], promptUsed: false }, fn);
}

/**
 * The config to call with: today's, with the frozen run's values over the top.
 *
 * Frozen wins, live fills the gaps — which is what makes omitting a secret from
 * the record correct rather than merely safe: the key was never frozen, so this
 * falls through to the one configured now.
 *
 * @param {object} live - the service's config module
 * @returns {object} a merged copy; the module itself is never mutated
 */
function config(live) {
  const scope = storage.getStore();
  if (!scope?.call) return live;

  const { params, restored, ignored } = mergeFrozen(live, scope.call);
  scope.restored.push(...restored);
  scope.ignored.push(...ignored);
  return params;
}

/**
 * The prompt template to use: the frozen run's, if there is one.
 *
 * Only the TEMPLATE. The assembled prompt — template plus seeds plus manuscript
 * — is not stored, only its digest, and it does not need to be: assembling the
 * frozen template over the frozen inputs reproduces it, and `verify()` checks
 * that it did.
 *
 * @param {string} live - the template as the repo holds it today
 * @returns {string}
 */
function prompt(live) {
  const scope = storage.getStore();
  if (!scope?.promptText) return live;
  scope.promptUsed = true;
  return scope.promptText;
}

/**
 * A Gemini call's parameters, with the frozen run's model over the top.
 *
 * Applied in the shared wrapper rather than in each service, so no module can
 * be left out — the failure this whole area keeps producing. The service's own
 * `config.model` is untouched: what it RECORDS stays the live config, and what
 * was overridden is reported separately by `current()`. A record that quietly
 * showed the frozen value would make a frozen restart indistinguishable from a
 * config change.
 *
 * The generation config is not restored, and does not need to be: it is one
 * app-wide constant (`DEFAULT_GENERATION_CONFIG`), so `appVersion` already says
 * which one a run used.
 *
 * @param {object} params - `{ model, contents, config }`
 * @returns {object} the same object, or a copy with the frozen model
 */
function forModelCall(params) {
  const scope = storage.getStore();
  const frozenModel = scope?.call?.model;
  if (!frozenModel || frozenModel === params?.model) return params;
  scope.restored.push('model');
  return { ...params, model: frozenModel };
}

/**
 * Did the reassembled prompt come out as the frozen run's?
 *
 * The proof the whole mechanism rests on. A frozen restart that quietly sent a
 * different prompt would be worse than one that refused: the user would compare
 * two results believing one variable had been held still.
 *
 * @param {string} assembled - the prompt actually about to be sent
 * @param {string} [expectedSha256] - `prompt.assembledSha256` from the record
 * @returns {{checked: boolean, matched: boolean}}
 */
function verify(assembled, expectedSha256) {
  const scope = storage.getStore();
  if (!scope || !expectedSha256) return { checked: false, matched: false };
  const { sha256 } = require('../services/queue/run-inputs.service');
  const matched = sha256(assembled) === expectedSha256;
  scope.verified = matched;
  return { checked: true, matched };
}

/**
 * What this step actually reproduced, for the record and for the UI.
 *
 * Null outside a frozen restart, so a caller can tell "ran live" from "ran
 * frozen and changed nothing".
 *
 * @returns {{restored: string[], ignored: string[], promptUsed: boolean, verified: boolean|undefined}|null}
 */
function current() {
  const scope = storage.getStore();
  if (!scope) return null;
  return {
    restored: [...new Set(scope.restored)],
    ignored: [...new Set(scope.ignored)],
    promptUsed: scope.promptUsed,
    verified: scope.verified
  };
}

/** Whether a frozen restart is in scope at all. @returns {boolean} */
const active = () => !!storage.getStore();

module.exports = { run, config, prompt, forModelCall, verify, current, active };
