/**
 * Tests for Gemini JSON recovery.
 *
 * The case that matters: a response truncated by maxOutputTokens used to lose
 * EVERY row, not just the incomplete one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeJsonEscapes, salvageTruncatedObjects, extractJsonBlock, hasParseableBody
} = require('./gemini-json');

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

// ── hasParseableBody ────────────────────────────────────────────────────────
// The distinction the detectors depend on: "I found none of these" is an
// answer; "no readable body" is a failed call. Treating the second as the first
// made a safety-blocked response indistinguishable from a clean manuscript.

test('an EMPTY LIST is a real answer', () => {
  assert.equal(hasParseableBody('{"resources": []}'), true);
  assert.equal(hasParseableBody('[]'), true);
  assert.equal(hasParseableBody(`${FENCE}json\n{"resources": []}\n${FENCE}`), true);
});

test('no readable body is NOT an answer', () => {
  for (const body of ['', '   ', null, undefined, 'I was unable to complete this request.']) {
    assert.equal(hasParseableBody(body), false, `${JSON.stringify(body)} must not count as an answer`);
  }
});

test('a truncated body still counts, because the salvage can read it', () => {
  // That path exists for responses cut at the token limit; discarding them
  // would throw away rows that did complete.
  assert.equal(hasParseableBody('{"resources":[{"resourceName":"CellProfiler"},{"resourceName":"Fi'), true);
});

test('a fenced but empty block is not an answer', () => {
  assert.equal(hasParseableBody(`${FENCE}json\n\n${FENCE}`), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Which list an object came from
// ─────────────────────────────────────────────────────────────────────────────

const TWO_LISTS = '{"resources":[{"resourceName":"CellProfiler"},{"resourceName":"Fiji"}],' +
                  '"dropped":[{"resourceName":"Figure 3","reason":"not a resource"}]}';

test('a rejected candidate does not come back as a kept resource', () => {
  // The consolidation response carries both lists and they mean opposite
  // things. Flattening them put "Figure 3" into the Generated KRT as a kept
  // row, and left the dropped-candidates audit table empty.
  const kept = salvageTruncatedObjects(TWO_LISTS, 'resources');
  assert.deepEqual(kept.map(r => r.resourceName), ['CellProfiler', 'Fiji']);
});

test('the dropped list is recoverable in its own right', () => {
  const dropped = salvageTruncatedObjects(TWO_LISTS, 'dropped');
  assert.deepEqual(dropped.map(r => r.resourceName), ['Figure 3']);
});

test('an absent key yields nothing rather than another list', () => {
  // Falling back to "whatever array is there" is how the two got confused in
  // the first place.
  assert.deepEqual(salvageTruncatedObjects(TWO_LISTS, 'suggestions'), []);
});

test('with no key, only the first list is read', () => {
  const out = salvageTruncatedObjects(TWO_LISTS);
  assert.deepEqual(out.map(r => r.resourceName), ['CellProfiler', 'Fiji']);
});

test('truncation mid-first-list still keeps what completed', () => {
  // The case the salvage exists for: `dropped` was never reached.
  const cut = '{"resources":[{"resourceName":"CellProfiler"},{"resourceName":"Fi';
  assert.deepEqual(salvageTruncatedObjects(cut, 'resources').map(r => r.resourceName), ['CellProfiler']);
  assert.deepEqual(salvageTruncatedObjects(cut, 'dropped'), []);
});

test('truncation mid-SECOND-list keeps both lists apart', () => {
  const cut = '{"resources":[{"a":1}],"dropped":[{"b":2},{"b":';
  assert.deepEqual(salvageTruncatedObjects(cut, 'resources'), [{ a: 1 }]);
  assert.deepEqual(salvageTruncatedObjects(cut, 'dropped'), [{ b: 2 }]);
});

test('a nested array inside a row is not mistaken for the rows array', () => {
  const text = '{"resources":[{"name":"X","aliases":[{"v":"Y"}]},{"name":"Z"}]}';
  assert.deepEqual(salvageTruncatedObjects(text, 'resources').map(r => r.name), ['X', 'Z']);
});

test('a bare array of objects still works with no key', () => {
  // kr-comparison accepts `parsed.decisions || parsed`, so the body may have
  // no envelope at all.
  assert.deepEqual(salvageTruncatedObjects('[{"row":1},{"row":2},{"row"'), [{ row: 1 }, { row: 2 }]);
});

test('a bare stream of sibling objects still works', () => {
  assert.deepEqual(salvageTruncatedObjects('{"row":1},{"row":2},{'), [{ row: 1 }, { row: 2 }]);
});
