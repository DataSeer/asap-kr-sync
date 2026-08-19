/**
 * Tests for Gemini JSON recovery.
 *
 * The case that matters: a response truncated by maxOutputTokens used to lose
 * EVERY row, not just the incomplete one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeJsonEscapes, salvageTruncatedObjects, extractJsonBlock } = require('./gemini-json');

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

// ── extractJsonBlock ────────────────────────────────────────────────────────
// Five copies of this lived in the detectors, in three behaviours. Each case
// below is one of the copies' actual failures, so a future re-divergence has to
// break a test rather than a run.

const FENCE = '```';

test('takes the JSON out of a fenced response', () => {
  assert.equal(extractJsonBlock(`${FENCE}json\n{"a":1}\n${FENCE}`), '{"a":1}');
  assert.equal(extractJsonBlock(`${FENCE}\n{"a":1}\n${FENCE}`), '{"a":1}');
});

test('a preamble before the fence does not defeat it', () => {
  // datasets' stripMarkdownFences returned early unless the text STARTED with
  // a fence, so one polite line from the model left the fence in the JSON.
  const out = extractJsonBlock(`Here is the JSON you asked for:\n${FENCE}json\n{"a":1}\n${FENCE}`);
  assert.equal(out, '{"a":1}');
  assert.deepEqual(JSON.parse(out), { a: 1 });
});

test('an UNTERMINATED fence still yields its body', () => {
  // The truncation case. stripFences and das-suggestions' copy required a
  // closing fence, so a response cut at the token limit was handed to
  // JSON.parse with its opener attached — and every salvageable row was lost
  // at exactly the point the salvage path existed to rescue them.
  const text = `${FENCE}json\n[{"name":"one"},{"name":"tw`;
  const out = extractJsonBlock(text);
  assert.ok(!out.startsWith(FENCE), 'the opener must be gone');
  assert.deepEqual(salvageTruncatedObjects(out), [{ name: 'one' }]);
});

test('prefers the LAST block, which is the answer after any thinking aloud', () => {
  assert.equal(extractJsonBlock(`${FENCE}json\n{"draft":1}\n${FENCE}\nOn reflection:\n${FENCE}json\n{"final":2}\n${FENCE}`),
    '{"final":2}');
});

test('unfenced JSON is returned untouched', () => {
  assert.equal(extractJsonBlock('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonBlock('  {"a":1}  '), '{"a":1}');
});

test('a non-string is a string, not a crash', () => {
  assert.equal(extractJsonBlock(null), '');
  assert.equal(extractJsonBlock(undefined), '');
  assert.equal(extractJsonBlock({}), '');
});
