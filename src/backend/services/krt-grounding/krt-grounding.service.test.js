/**
 * Tests for the grounding service's pure helpers.
 *
 * The DB/S3/LM paths are exercised end-to-end elsewhere; what is worth pinning
 * here is the parsing of an untrusted LM response — a malformed or fabricated
 * second-look answer must never become a "confirmed" verdict.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseSecondLookResponse, recount } = require('./krt-grounding.service');

test('parseSecondLookResponse reads the documented shape', () => {
  const out = parseSecondLookResponse('{"found":[{"index":0,"quote":"anti-TH antibody"}]}');
  assert.deepEqual(out, [{ index: 0, quote: 'anti-TH antibody' }]);
});

test('parseSecondLookResponse accepts a bare array', () => {
  const out = parseSecondLookResponse('[{"index":2,"quote":"a quote"}]');
  assert.deepEqual(out, [{ index: 2, quote: 'a quote' }]);
});

test('parseSecondLookResponse unwraps a fenced block', () => {
  const out = parseSecondLookResponse('```json\n{"found":[{"index":1,"quote":"x y z"}]}\n```');
  assert.deepEqual(out, [{ index: 1, quote: 'x y z' }]);
});

test('parseSecondLookResponse drops entries missing an index or quote', () => {
  const out = parseSecondLookResponse(
    '{"found":[{"index":0},{"quote":"no index"},{"index":"1","quote":"string index"},{"index":3,"quote":"  "},{"index":4,"quote":"ok"}]}'
  );
  assert.deepEqual(out, [{ index: 4, quote: 'ok' }]);
});

test('parseSecondLookResponse returns [] on junk instead of throwing', () => {
  assert.deepEqual(parseSecondLookResponse('not json at all'), []);
  assert.deepEqual(parseSecondLookResponse(''), []);
  assert.deepEqual(parseSecondLookResponse(null), []);
  assert.deepEqual(parseSecondLookResponse('{"found":"nope"}'), []);
});

test('recount tallies outcomes after the second look upgraded rows', () => {
  const stats = recount(
    [
      { outcome: 'confirmed' },
      { outcome: 'confirmed' },
      { outcome: 'incomplete' },
      { outcome: 'partial' },
      { outcome: 'not_detected' }
    ],
    12,
    9
  );
  assert.deepEqual(stats, {
    authorRows: 5,
    confirmed: 2,
    incomplete: 1,
    // Counted on its own. Folded into notDetected by a catch-all `else`, a
    // located-but-weakly-matched row would be reported as absent from the paper.
    partial: 1,
    notDetected: 1,
    candidates: 12,
    unmatchedCandidates: 9
  });
});

test('recount handles the no-KRT mode', () => {
  const stats = recount([], 7, 7);
  assert.equal(stats.authorRows, 0);
  assert.equal(stats.unmatchedCandidates, 7);
});
