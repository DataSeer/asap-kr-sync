/**
 * The shared-key rule, and the startup pass that makes it true of the
 * environment rather than only of JavaScript.
 *
 * Context: nine modules each carried their own `A || B || ''` chain. Datasets
 * detection is the one that spawns a child process, which inherits variables
 * and not expressions -- so the chain resolved in Node, every status check
 * reported the module configured, and the Python script exited 1 on a missing
 * variable for every manuscript processed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_MODEL,
  isRealKey,
  GEMINI_MODULES,
  geminiKey,
  geminiModel,
  applyGeminiDefaults,
  geminiKeySources
} = require('./gemini');

test('a module with its own key uses it', () => {
  const env = { GEMINI_API_KEY: 'shared', DATASETS_DETECTION_GEMINI_API_KEY: 'own' };
  assert.equal(geminiKey('DATASETS_DETECTION', env), 'own');
});

test('a module without its own key inherits the shared one', () => {
  assert.equal(geminiKey('DATASETS_DETECTION', { GEMINI_API_KEY: 'shared' }), 'shared');
});

test('no key anywhere resolves to empty, not to undefined', () => {
  assert.equal(geminiKey('DATASETS_DETECTION', {}), '');
});

/**
 * A copied-but-unfilled .env line.
 *
 * Two modules guarded against this privately and seven did not, so the same
 * `.env` made some modules report themselves off and others report themselves
 * on and then fail with a 400 on every call. Worse after the startup pass,
 * which would have written the placeholder into all nine names and handed it to
 * the LangExtract child.
 */
test('a placeholder is not a key', () => {
  for (const junk of ['changeme', 'your_api_key', 'your_gemini_api_key', '  CHANGEME  ', '']) {
    assert.equal(geminiKey('DATASETS_DETECTION', { GEMINI_API_KEY: junk }), '', junk);
  }
});

test('a module whose own key is a placeholder falls back to the shared one', () => {
  const env = { GEMINI_API_KEY: 'real-key', DATASETS_DETECTION_GEMINI_API_KEY: 'changeme' };
  assert.equal(geminiKey('DATASETS_DETECTION', env), 'real-key');
});

/**
 * Startup runs the pass twice: at require time, then again after the secret
 * loader Object.assigns credentials into process.env. A value the pass wrote
 * itself is not the operator's choice and must not shadow a fresher one.
 */
test('a key arriving after the first pass replaces the one it filled in', () => {
  const env = { GEMINI_API_KEY: 'stale' };
  applyGeminiDefaults(env);
  assert.equal(env.DATASETS_DETECTION_GEMINI_API_KEY, 'stale');

  env.GEMINI_API_KEY = 'rotated';           // the secret loader
  applyGeminiDefaults(env);

  assert.equal(env.DATASETS_DETECTION_GEMINI_API_KEY, 'rotated',
    'a key the pass filled in must not shadow a rotated one');
});

test('a value the OPERATOR set is never revised', () => {
  const env = { GEMINI_API_KEY: 'shared', DATASETS_DETECTION_GEMINI_API_KEY: 'operator' };
  applyGeminiDefaults(env);
  env.GEMINI_API_KEY = 'rotated';
  applyGeminiDefaults(env);

  assert.equal(env.DATASETS_DETECTION_GEMINI_API_KEY, 'operator');
});

test('a model chosen after the first pass takes effect', () => {
  // The pass used to fill every model name with the built-in default, so by the
  // time a GEMINI_MODEL arrived from Secrets Manager nothing was missing and it
  // could never apply. Only a chosen model is written now.
  const env = { GEMINI_API_KEY: 'k' };
  applyGeminiDefaults(env);
  assert.equal('DATASETS_DETECTION_GEMINI_MODEL' in env, false,
    'the built-in default must not be written into the environment');

  env.GEMINI_MODEL = 'gemini-2.5-pro';
  applyGeminiDefaults(env);

  assert.equal(env.DATASETS_DETECTION_GEMINI_MODEL, 'gemini-2.5-pro');
});

test('a placeholder is replaced, or removed when nothing real replaces it', () => {
  // Truthiness alone let `your_gemini_api_key` survive and reach the child.
  const withReal = { GEMINI_API_KEY: 'real', DATASETS_DETECTION_GEMINI_API_KEY: 'changeme' };
  applyGeminiDefaults(withReal);
  assert.equal(withReal.DATASETS_DETECTION_GEMINI_API_KEY, 'real');

  const withNone = { DATASETS_DETECTION_GEMINI_API_KEY: 'your_gemini_api_key' };
  applyGeminiDefaults(withNone);
  assert.equal('DATASETS_DETECTION_GEMINI_API_KEY' in withNone, false,
    'the script reports which names it looked for; a placeholder turns that '
    + 'into a 400 from Gemini instead');
});

test('startup never propagates a placeholder', () => {
  const env = { GEMINI_API_KEY: 'your_gemini_api_key' };
  applyGeminiDefaults(env);
  for (const m of GEMINI_MODULES) {
    assert.equal(`${m}_GEMINI_API_KEY` in env, false, m);
  }
});

test('the model follows the same rule, with a built-in default', () => {
  assert.equal(geminiModel('KRT_COMPARISON', { KRT_COMPARISON_GEMINI_MODEL: 'own' }), 'own');
  assert.equal(geminiModel('KRT_COMPARISON', { GEMINI_MODEL: 'shared' }), 'shared');
  assert.equal(geminiModel('KRT_COMPARISON', {}), DEFAULT_MODEL);
});

test('startup writes the shared key into every module that lacks its own', () => {
  const env = { GEMINI_API_KEY: 'shared' };
  applyGeminiDefaults(env);
  for (const module of GEMINI_MODULES) {
    assert.equal(env[`${module}_GEMINI_API_KEY`], 'shared', module);
  }
});

test('startup never overwrites a value the operator set', () => {
  const env = {
    GEMINI_API_KEY: 'shared',
    GEMINI_MODEL: 'shared-model',
    DATASETS_DETECTION_GEMINI_API_KEY: 'own-key',
    DATASETS_DETECTION_GEMINI_MODEL: 'own-model'
  };
  const filled = applyGeminiDefaults(env);
  assert.equal(env.DATASETS_DETECTION_GEMINI_API_KEY, 'own-key');
  assert.equal(env.DATASETS_DETECTION_GEMINI_MODEL, 'own-model');
  assert.equal(env.MATERIALS_DETECTION_GEMINI_API_KEY, 'shared');

  // Asserting the values alone cannot fail: the resolvers already prefer the
  // module's own value, so re-resolving a variable that is set yields the
  // identical string whether or not the guard exists. What the guard actually
  // governs is which names are REPORTED as filled -- so that is what is checked.
  assert.equal(filled.includes('DATASETS_DETECTION_GEMINI_API_KEY'), false,
    'a variable the operator set must not be reported as filled in');
  assert.equal(filled.includes('DATASETS_DETECTION_GEMINI_MODEL'), false);
  assert.ok(filled.includes('MATERIALS_DETECTION_GEMINI_API_KEY'));
});

test('with nothing configured, nothing is written', () => {
  // An empty key would read as "configured" to isConfigured(), turning "nobody
  // set a key" into a module that claims to be on and then fails.
  //
  // The MODEL is left alone for a different reason: writing the built-in
  // default here is what stopped a `GEMINI_MODEL` arriving later from Secrets
  // Manager from taking effect. `geminiModel()` still answers with the default,
  // so nothing downstream is left guessing.
  const env = {};
  applyGeminiDefaults(env);

  assert.equal('MATERIALS_DETECTION_GEMINI_API_KEY' in env, false);
  assert.equal('MATERIALS_DETECTION_GEMINI_MODEL' in env, false);
  assert.equal(geminiModel('MATERIALS_DETECTION', env), DEFAULT_MODEL);
});

test('running startup twice changes nothing the second time', () => {
  const env = { GEMINI_API_KEY: 'shared' };
  applyGeminiDefaults(env);
  const snapshot = JSON.stringify(env);
  assert.deepEqual(applyGeminiDefaults(env), []);
  assert.equal(JSON.stringify(env), snapshot);
});

test('geminiKeySources reports where each key came from', () => {
  const env = { GEMINI_API_KEY: 'shared', DATASETS_DETECTION_GEMINI_API_KEY: 'own' };
  const by = Object.fromEntries(geminiKeySources(env).map((s) => [s.module, s]));
  assert.equal(by.DATASETS_DETECTION.own, true);
  assert.equal(by.MATERIALS_DETECTION.own, false);
  assert.equal(by.MATERIALS_DETECTION.hasKey, true);
});

/**
 * Structural. The rule is only worth having in one place if nothing keeps its
 * own copy -- a new module with a private `||` chain would inherit correctly in
 * Node and still be invisible to the startup pass, which is how the original
 * failure worked.
 *
 * Two deliberate choices about what this looks at:
 *
 * The whole backend, not just config/. The second half of that failure lived in
 * a SERVICE, which read DATASETS_DETECTION_GEMINI_MODEL directly.
 *
 * Any access form, not just `process.env.NAME`. The natural way to write a
 * variable name built from a prefix is process.env[`${mod}_GEMINI_API_KEY`],
 * and a dot-notation regex cannot see it -- so this looks for `process.env` and
 * a per-module name close together, which catches dot, bracket, template and
 * destructured reads alike. Naming the variable in a comment or a log message
 * is not a read, so lines without `process.env` do not count.
 */
test('nothing outside config/gemini.js resolves a Gemini variable itself', () => {
  const ROOT = path.join(__dirname, '..');
  const SKIP = new Set(['node_modules', 'python', '.git']);
  const NAME = /[A-Z][A-Z0-9_]*_GEMINI_(?:API_KEY|MODEL)/;
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js') || e.name.includes('.test.')) continue;
      if (full === path.join(__dirname, 'gemini.js')) continue;
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('process.env') && NAME.test(line)) {
          offenders.push(`${path.relative(ROOT, full)}:${i + 1}`);
        }
      });
    }
  };
  walk(ROOT);
  assert.deepEqual(
    offenders, [],
    'these read a per-module Gemini variable from the environment instead of '
    + 'calling geminiKey()/geminiModel(), so applyGeminiDefaults() cannot reach them'
  );
});

test('GEMINI_MODULES lists every module that has a Gemini config', () => {
  const dir = __dirname;
  const found = new Set();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js') || name.includes('.test.') || name === 'gemini.js') continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/gemini(?:Key|Model)\('([A-Z_]+)'\)/g)) found.add(m[1]);
  }
  assert.deepEqual(
    [...found].sort(), [...GEMINI_MODULES].sort(),
    'a module resolving a Gemini key is missing from GEMINI_MODULES (or vice '
    + 'versa), so startup would skip it'
  );
});
