/**
 * How every Gemini-backed module resolves its API key and model.
 *
 * The rule, in one sentence: a module uses its own value if one is set, and
 * the shared value otherwise.
 *
 * Nine modules call Gemini. Each may carry its own key -- a separate quota, a
 * separate billing account -- but the normal deployment sets one shared
 * GEMINI_API_KEY and nothing else. That rule used to be written out nine
 * times, once per config file, as an identical `A || B || ''` chain.
 *
 * Nine copies of a rule is nine chances to write it differently, but the
 * reason it lives here is sharper than tidiness. Datasets detection does its
 * work in a CHILD PROCESS, and a child does not inherit a JavaScript
 * expression -- it inherits environment variables. The `||` chain resolved
 * correctly in Node, every status check reported the module configured, and
 * the Python script it spawns looked up DATASETS_DETECTION_GEMINI_API_KEY,
 * found nothing, and exited 1 on every manuscript. The module looked healthy
 * right up to the point where it produced nothing.
 *
 * So resolution happens once, at startup, and is written BACK into the
 * environment by `applyGeminiDefaults`. After that the per-module variables
 * are really set, and anything downstream -- a config file, a child process, a
 * script reading `process.env` directly -- sees the same answer without having
 * to re-derive it.
 */

'use strict';

/** Used when neither the module nor the deployment names a model. */
const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Every module that calls Gemini, by the prefix its variables use.
 *
 * Kept as data so startup can walk it, and so a test can assert it still
 * matches the config files on disk -- a module added without an entry here
 * would silently stop inheriting the shared key, which is the exact failure
 * this file exists to prevent.
 */
const GEMINI_MODULES = [
  'DAS_EXTRACTION',
  'DAS_SUGGESTIONS',
  'DATASETS_DETECTION',
  'KRT_COMPARISON',
  'KRT_GENERATION',
  'KRT_GROUNDING',
  'MATERIALS_DETECTION',
  'PROTOCOLS_DETECTION',
  'SOFTWARE_DETECTION'
];

/**
 * Values that look like a key but are not one.
 *
 * A copied-but-unfilled `.env` line is indistinguishable from a real key to
 * anything that only checks for a non-empty string: the module reports itself
 * configured, and the failure surfaces as a 400 from Gemini on every call
 * rather than as "you have not set a key". Two modules already guarded against
 * this privately; the other seven did not, and the startup pass would have
 * propagated a placeholder into all nine names.
 */
const PLACEHOLDER_KEYS = new Set(['your_gemini_api_key', 'your_api_key', 'changeme', '']);

/**
 * Is this a key rather than a leftover placeholder?
 *
 * @param {string} key
 * @returns {boolean}
 */
function isRealKey(key) {
  return !PLACEHOLDER_KEYS.has(String(key || '').trim().toLowerCase());
}

/**
 * The API key a module should use: its own if set, else the shared one.
 *
 * @param {string} module - variable prefix, e.g. 'DATASETS_DETECTION'
 * @param {object} [env] - environment to read (injectable for tests)
 * @returns {string} the key, or '' when neither is set
 */
function geminiKey(module, env = process.env) {
  const own = env[`${module}_GEMINI_API_KEY`];
  if (isRealKey(own)) return own;
  const shared = env.GEMINI_API_KEY;
  return isRealKey(shared) ? shared : '';
}

/**
 * The model a module should call: its own if named, else the shared one, else
 * the default.
 *
 * @param {string} module - variable prefix, e.g. 'DATASETS_DETECTION'
 * @param {object} [env] - environment to read (injectable for tests)
 * @returns {string} a model id, never empty
 */
function geminiModel(module, env = process.env) {
  return env[`${module}_GEMINI_MODEL`] || env.GEMINI_MODEL || DEFAULT_MODEL;
}

/**
 * Write the resolved key and model for every module back into the
 * environment. Call once at startup, after the .env files are loaded and
 * before anything reads a config.
 *
 * A variable that is already set is left exactly as it is -- the specific
 * value always wins, which is the whole point of allowing one.
 *
 * A module with no key anywhere is left unset rather than set to ''. This is
 * housekeeping, not a safety property: `isConfigured()` reads the RESOLVED
 * value from `geminiKey()`, and '' is falsy on both sides of the process
 * boundary (`extract-signals.py` chains its two lookups with `or`), so an empty
 * variable and an absent one already behave identically. The reason to leave it
 * out is simply that `process.env` should not gain nine names nobody set.
 *
 * Idempotent: running it twice changes nothing the second time.
 *
 * @param {object} [env] - environment to mutate (injectable for tests)
 * @returns {string[]} the variable names that were filled in
 */
/**
 * Names THIS process filled in, so a later pass may revise them.
 *
 * Startup runs the pass twice: once when this file is required, and again after
 * the secret loader, which `Object.assign`s credentials into `process.env`. A
 * value the pass wrote itself is not the operator's choice, so it must not
 * block a fresher one arriving in between — a key rotated in Secrets Manager
 * would otherwise be shadowed on all nine modules by whatever `.env` held.
 *
 * Per environment object, so a caller passing its own (tests, the LangExtract
 * boundary) is unaffected by what the real environment did.
 */
const filledBy = new WeakMap();

function applyGeminiDefaults(env = process.env) {
  const filled = [];
  const ours = filledBy.get(env) || new Set();
  filledBy.set(env, ours);
  for (const module of GEMINI_MODULES) {
    for (const [suffix, resolve] of [['GEMINI_API_KEY', geminiKey], ['GEMINI_MODEL', geminiModel]]) {
      const name = `${module}_${suffix}`;
      // Truthiness is not enough for the key: a copied-but-unfilled
      // `<MODULE>_GEMINI_API_KEY=your_gemini_api_key` is truthy, so a raw guard
      // left the placeholder in place and handed it to the LangExtract child --
      // which is the failure this whole module exists to prevent, arriving from
      // the one direction it did not check.
      const isKey = suffix === 'GEMINI_API_KEY';
      const present = isKey ? isRealKey(env[name]) : !!env[name];
      // Present AND the operator's own: leave it. Present because an earlier
      // pass wrote it: re-resolve, in case something fresher has since arrived.
      if (present && !ours.has(name)) continue;
      // The MODEL is only written when somebody actually chose one. It used to
      // be filled with the built-in default, which looks harmless and is not:
      // the pass runs again after the secret loader, and by then every model
      // name was already set, so a `GEMINI_MODEL` arriving from Secrets Manager
      // could never take effect. Nothing reads these names except the
      // LangExtract child, which carries its own default.
      // Resolving a name WE wrote has to ignore that write, or the resolver
      // reads its own output back: `geminiKey` prefers the per-module variable,
      // which is exactly the stale value a second pass is trying to replace.
      const previous = env[name];
      if (ours.has(name)) delete env[name];
      const value = isKey
        ? resolve(module, env)
        : (env[`${module}_GEMINI_MODEL`] || env.GEMINI_MODEL || '');
      if (ours.has(name) && previous !== undefined) env[name] = previous;
      // A placeholder with nothing real to replace it is REMOVED rather than
      // left standing. The script reads this variable first and reports the
      // names it looked for; leaving `your_gemini_api_key` in place turns a
      // clear "no key is set" into a 400 from Gemini on every chunk.
      if (isKey && !value && env[name] !== undefined) delete env[name];
      if (!value) continue;
      // Idempotent: a pass that resolves the same answer reports no change.
      if (env[name] === value) continue;
      env[name] = value;
      ours.add(name);
      filled.push(name);
    }
  }
  return filled;
}

/**
 * Which modules have a key and where it came from -- for the startup summary,
 * and for diagnosing "the module says it is on but produces nothing".
 *
 * Read it BEFORE applyGeminiDefaults to see what the operator configured;
 * after, every module reports `own: true` by construction.
 *
 * @param {object} [env] - environment to read
 * @returns {Array<{module: string, hasKey: boolean, own: boolean, model: string}>}
 */
function geminiKeySources(env = process.env) {
  return GEMINI_MODULES.map((module) => ({
    module,
    hasKey: !!geminiKey(module, env),
    // A placeholder is not a key of one's own, or the startup line reports a
    // module as configured by exactly the value that will fail.
    own: isRealKey(env[`${module}_GEMINI_API_KEY`]),
    model: geminiModel(module, env)
  }));
}

module.exports = {
  DEFAULT_MODEL,
  isRealKey,
  GEMINI_MODULES,
  geminiKey,
  geminiModel,
  applyGeminiDefaults,
  geminiKeySources
};
