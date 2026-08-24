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
 * The API key a module should use: its own if set, else the shared one.
 *
 * @param {string} module - variable prefix, e.g. 'DATASETS_DETECTION'
 * @param {object} [env] - environment to read (injectable for tests)
 * @returns {string} the key, or '' when neither is set
 */
function geminiKey(module, env = process.env) {
  return env[`${module}_GEMINI_API_KEY`] || env.GEMINI_API_KEY || '';
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
 * value always wins, which is the whole point of allowing one. Only the gaps
 * are filled, and only when there is something to fill them with: with no
 * shared key set, a module without its own key stays unset rather than gaining
 * an empty string, so `isConfigured()` can still tell "no key" from "a key".
 *
 * Idempotent: running it twice changes nothing the second time.
 *
 * @param {object} [env] - environment to mutate (injectable for tests)
 * @returns {string[]} the variable names that were filled in
 */
function applyGeminiDefaults(env = process.env) {
  const filled = [];
  for (const module of GEMINI_MODULES) {
    for (const [suffix, resolve] of [['GEMINI_API_KEY', geminiKey], ['GEMINI_MODEL', geminiModel]]) {
      const name = `${module}_${suffix}`;
      if (env[name]) continue;
      const value = resolve(module, env);
      // The model always resolves to the built-in default; the key can be
      // genuinely absent, and an empty string would read as "configured".
      if (!value) continue;
      env[name] = value;
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
    own: !!env[`${module}_GEMINI_API_KEY`],
    model: geminiModel(module, env)
  }));
}

module.exports = {
  DEFAULT_MODEL,
  GEMINI_MODULES,
  geminiKey,
  geminiModel,
  applyGeminiDefaults,
  geminiKeySources
};
