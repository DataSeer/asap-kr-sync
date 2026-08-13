/**
 * Tests for the shared Gemini generation defaults.
 *
 * The point of applying these centrally is that a call site cannot opt out by
 * forgetting — which is exactly how every call ended up at the API's default
 * temperature of 1.0. These pin that behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withDefaultGenerationConfig, DEFAULT_GENERATION_CONFIG } = require('./gemini');

test('a call with no config at all gets temperature 0', () => {
  const out = withDefaultGenerationConfig({ model: 'gemini-2.5-flash', contents: [] });
  assert.equal(out.config.temperature, 0);
  assert.equal(out.model, 'gemini-2.5-flash');
});

test('an existing config is preserved and temperature added', () => {
  const out = withDefaultGenerationConfig({
    model: 'm',
    config: { responseMimeType: 'application/json', maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 0 } }
  });
  assert.equal(out.config.temperature, 0);
  assert.equal(out.config.responseMimeType, 'application/json');
  assert.equal(out.config.maxOutputTokens, 32768);
  assert.deepEqual(out.config.thinkingConfig, { thinkingBudget: 0 }, 'thinking stays a per-call decision');
});

test('an explicit caller temperature always wins', () => {
  const out = withDefaultGenerationConfig({ model: 'm', config: { temperature: 0.7 } });
  assert.equal(out.config.temperature, 0.7);
});

test('an explicit temperature of 0 is not confused with "unset"', () => {
  const out = withDefaultGenerationConfig({ model: 'm', config: { temperature: 0 } });
  assert.equal(out.config.temperature, 0);
});

test('the original params object is not mutated', () => {
  const params = { model: 'm', config: { maxOutputTokens: 100 } };
  withDefaultGenerationConfig(params);
  assert.equal(params.config.temperature, undefined);
});

test('tolerates junk input', () => {
  assert.equal(withDefaultGenerationConfig({}).config.temperature, 0);
  assert.equal(withDefaultGenerationConfig({ config: null }).config.temperature, 0);
});

test('defaults deliberately do not include thinkingConfig', () => {
  assert.equal('thinkingConfig' in DEFAULT_GENERATION_CONFIG, false);
});
