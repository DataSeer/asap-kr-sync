/**
 * Tests for the grounding service's pure helpers.
 *
 * The DB/S3/LM paths are exercised end-to-end elsewhere; what is worth pinning
 * here is the parsing of an untrusted LM response — a malformed or fabricated
 * second-look answer must never become a "confirmed" verdict.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseSecondLookResponse, recount, presenceForRows } = require('./krt-grounding.service');
const { buildEvidenceIndex } = require('../pdf-analysis/evidence.service');

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


/**
 * Presence — the manuscript searched directly for each author row.
 *
 * This is the half of grounding that does not depend on what any detector
 * found, and the only half that stays honest under a seeded pipeline: candidate
 * matching there can mean "the model repeated the row we handed it", while a
 * search of the manuscript cannot be affected by what the prompt was given.
 */
const MANUSCRIPT = 'Cells were stained with anti-LAMP1 (Cell Signaling, RRID:AB\\_2687579) '
  + 'overnight, then imaged in Fiji. Analysis used anti-LAMP1 again at 1:1000.';

test('presence: an identifier hit outranks a name hit', () => {
  const index = buildEvidenceIndex(MANUSCRIPT);
  const found = presenceForRows(index, [{ id: 'r1', resourceName: 'anti-LAMP1', identifier: 'RRID:AB_2687579' }]);
  const p = found.get('r1');
  assert.equal(p.found, true);
  assert.equal(p.via, 'identifier', 'an identifier match is near-certain and should be reported as such');
  assert.ok(p.occurrences >= 2, 'every occurrence is counted, not just the first');
});

test('presence: a name-only row is found, and says so', () => {
  const index = buildEvidenceIndex(MANUSCRIPT);
  const p = presenceForRows(index, [{ id: 'r2', resourceName: 'Fiji', identifier: '' }]).get('r2');
  assert.equal(p.found, true);
  assert.equal(p.via, 'name', 'weaker than an identifier, and the caller needs to know which');
});

test('presence: a row the manuscript does not contain is absent', () => {
  const index = buildEvidenceIndex(MANUSCRIPT);
  const p = presenceForRows(index, [{ id: 'r3', resourceName: 'ZzzNotInThisPaper999', identifier: 'RRID:AB_0000000' }]).get('r3');
  assert.equal(p.found, false);
  assert.equal(p.via, null);
  assert.equal(p.occurrences, 0);
});

test('presence: an identifier the converter escaped is still found', () => {
  // The manuscript says RRID:AB\_2687579; the author's KRT says AB_2687579.
  // Before the backslash was folded away this was 127 of 164 RRIDs on the demo
  // corpus, and presence would have reported every one of them absent.
  const index = buildEvidenceIndex(MANUSCRIPT);
  const p = presenceForRows(index, [{ id: 'r4', resourceName: 'no-such-name', identifier: 'AB_2687579' }]).get('r4');
  assert.equal(p.found, true);
  assert.equal(p.via, 'identifier');
});

test('presence: rows are keyed by id, and an empty set is not an error', () => {
  const index = buildEvidenceIndex(MANUSCRIPT);
  assert.equal(presenceForRows(index, []).size, 0);
  assert.equal(presenceForRows(index, null).size, 0);
});
