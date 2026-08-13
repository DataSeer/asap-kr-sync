/**
 * Tests for Gemini JSON recovery.
 *
 * The case that matters: a response truncated by maxOutputTokens used to lose
 * EVERY row, not just the incomplete one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeJsonEscapes, salvageTruncatedObjects } = require('./gemini-json');

test('salvages complete objects from a truncated array', () => {
  // Mirrors the real failure: cap hit mid-way through an evidence_quote.
  const truncated = `{
  "resources": [
    { "canonical_name": "Wizard SV Gel Kit", "identifier": "A9282" },
    { "canonical_name": "anti-TH", "identifier": "AB_390204" },
    { "canonical_name": "partial", "evidence_quote": "Purification of DNA fragment`;

  const out = salvageTruncatedObjects(truncated);
  assert.equal(out.length, 2, 'the two complete objects survive');
  assert.equal(out[0].canonical_name, 'Wizard SV Gel Kit');
  assert.equal(out[1].identifier, 'AB_390204');
});

test('a brace inside a quoted value does not break depth tracking', () => {
  const text = '{"a":"has { and } inside"},{"b":"ok"},{"c":"trunc';
  const out = salvageTruncatedObjects(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].a, 'has { and } inside');
  assert.equal(out[1].b, 'ok');
});

test('an escaped quote inside a string does not end the string early', () => {
  const text = '{"quote":"he said \\"hi\\" loudly"},{"x":1},{"y":';
  const out = salvageTruncatedObjects(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].quote, 'he said "hi" loudly');
});

test('nested objects are kept whole, not split', () => {
  const text = '{"a":{"b":{"c":1}}},{"d":2},{"e":';
  const out = salvageTruncatedObjects(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { a: { b: { c: 1 } } });
});

test('returns [] when nothing is complete', () => {
  assert.deepEqual(salvageTruncatedObjects('{"a":"never closes'), []);
  assert.deepEqual(salvageTruncatedObjects(''), []);
  assert.deepEqual(salvageTruncatedObjects(null), []);
});

test('stray backslashes are still repaired inside salvaged objects', () => {
  const text = '{"note":"incubated at 4\\u00b0C with \\mu-tubulin"},{"x":';
  const out = salvageTruncatedObjects(text);
  assert.equal(out.length, 1);
  assert.ok(out[0].note.includes('tubulin'));
});

test('sanitizeJsonEscapes leaves valid escapes alone', () => {
  assert.equal(JSON.parse(sanitizeJsonEscapes('{"a":"line\\nbreak"}')).a, 'line\nbreak');
  assert.equal(JSON.parse(sanitizeJsonEscapes('{"a":"\\mu"}')).a, '\\mu');
});
