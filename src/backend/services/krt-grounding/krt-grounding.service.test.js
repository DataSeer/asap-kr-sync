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

// ── A truncated second look ────────────────────────────────────────────────
//
// Found by running a real 335-row manuscript: 107 rows went to the second look,
// two batches hit the model's token cap, and both were discarded WHOLE — one
// had cut mid-quote on its fifth entry, so four complete locations went with
// it. Every other LM module salvages a truncated response; this is the module
// where discarding one directly produces a wrong answer, because a row the
// model DID locate then stays `not_detected` — which the interface reports as
// "the manuscript does not mention this".

test('a batch cut mid-quote keeps the locations that completed', () => {
  const truncated = '{"found":[{"index":4,"quote":"Peptides were desalted using Sep-Pak tC18 Plates (Cat. No.: 186002319)."},'
    + '{"index":5,"quote":"The following reagents were used: Nunclon Delta (Thermo';

  const out = parseSecondLookResponse(truncated);

  assert.equal(out.length, 1, 'the completed entry survives');
  assert.equal(out[0].index, 4);
  assert.match(out[0].quote, /186002319/);
});

test('the half-written entry is dropped, not repaired', () => {
  // A quote cut in half is not a quote. It would fail the manuscript
  // re-verification anyway, but it must never reach it — a "location" invented
  // by truncation is exactly the kind of thing that erodes trust.
  const truncated = '{"found":[{"index":0,"quote":"complete sentence here."},{"index":1,"quote":"cut off mid';

  const out = parseSecondLookResponse(truncated);

  assert.deepEqual(out.map((h) => h.index), [0]);
});

test('a truncated batch with nothing complete yields nothing', () => {
  assert.deepEqual(parseSecondLookResponse('{"found":[{"index":0,"quote":"cut immediately'), []);
});

test('salvage reads `found` by name, not whatever array is present', () => {
  // The response envelope could grow a second list. Reading "the first array"
  // would then quietly take the wrong one.
  const truncated = '{"rejected":[{"index":9,"quote":"not a location"}],"found":[{"index":2,"quote":"a real quote."},{"index":3,"quote":"cut';

  const out = parseSecondLookResponse(truncated);

  assert.deepEqual(out.map((h) => h.index), [2], 'only entries from `found`');
});

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
    unmatchedCandidates: 9,
    conflicts: 0
  });
});

test('recount counts conflicting ROWS, not conflicting values', () => {
  // A row with three disagreeing cells is one row to go and check, which is
  // what the card's badge asks the reader to do. Counting values would inflate
  // it and mean something else.
  const stats = recount(
    [
      { outcome: 'confirmed', conflicts: [{ field: 'identifier' }, { field: 'source' }] },
      { outcome: 'confirmed', conflicts: [] },
      { outcome: 'incomplete', conflicts: [{ field: 'identifier' }] },
      { outcome: 'not_detected' }
    ],
    4,
    0
  );
  assert.equal(stats.conflicts, 2, 'two rows disagree, across three values');
  assert.equal(stats.confirmed, 2, 'a conflict does not change the located verdict');
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

// ── Each identifier in the cell, judged on its own ──────────────────────────
//
// An IDENTIFIER cell routinely holds several — a catalogue number AND an RRID,
// an RRID AND a DOI. They are separate claims, and the manuscript can support
// one without supporting the other: a paper citing an RRID almost never prints
// the vendor's catalogue number. One boolean for the whole cell answered a
// question nobody asked and hid the actionable half.

const TWO_IDS = 'Sections were stained with an anti-parkin antibody (RRID:AB_2201407) overnight.';

test('presence: each identifier gets its own verdict', () => {
  const index = buildEvidenceIndex(TWO_IDS);
  const p = presenceForRows(index, [
    { id: 'r1', resourceName: 'Anti-parkin', identifier: 'Cat#657012; RRID:AB_2201407' }
  ]).get('r1');

  assert.equal(p.identifiers.length, 2, 'two identifiers, two verdicts');
  assert.deepEqual(p.identifiers.map((i) => i.found), [false, true]);
  assert.deepEqual(p.identifiersNotFound, ['Cat#657012'],
    'the catalogue number is the one the manuscript does not corroborate');
  assert.equal(p.viaIdentifier, true, 'the row is still located — one of its identifiers is there');
});

test('presence: a verdict names the identifier the way the AUTHOR wrote it', () => {
  // The search needle is the bare token ("657012"); the author wrote
  // "Cat#657012". A verdict a curator cannot match to the cell in front of them
  // is not a verdict.
  const index = buildEvidenceIndex(TWO_IDS);
  const p = presenceForRows(index, [
    { id: 'r1', resourceName: 'Anti-parkin', identifier: 'Cat#657012; RRID:AB_2201407' }
  ]).get('r1');

  assert.equal(p.identifiers[0].value, 'Cat#657012', 'the author\'s text (not found)');
  assert.equal(p.identifiers[0].needle, '657012', 'and what was actually searched');
  // The found branch must carry it too — it is the one a curator reads most.
  assert.equal(p.identifiers[1].value, 'RRID:AB_2201407', 'the author\'s text (found)');
  assert.equal(p.identifiers[1].needle, 'AB_2201407');
});

test('presence: the per-identifier verdicts do not depend on the order typed', () => {
  const index = buildEvidenceIndex(TWO_IDS);
  const rows = [
    { id: 'a', resourceName: 'Anti-parkin', identifier: 'Cat#657012; RRID:AB_2201407' },
    { id: 'b', resourceName: 'Anti-parkin', identifier: 'RRID:AB_2201407; Cat#657012' }
  ];
  const out = presenceForRows(index, rows);

  const verdict = (id) => Object.fromEntries(out.get(id).identifiers.map((i) => [i.value, i.found]));
  assert.deepEqual(verdict('a'), verdict('b'));
  assert.deepEqual(out.get('a').identifiersNotFound, out.get('b').identifiersNotFound);
});

test('presence: an identifier found only after normalisation says so', () => {
  // The conversion breaks identifiers around punctuation.
  const index = buildEvidenceIndex('The conjugate N0502 -At488 -L was applied.');
  const p = presenceForRows(index, [
    { id: 'r1', resourceName: 'Conjugate', identifier: 'N0502-At488-L' }
  ]).get('r1');

  assert.equal(p.identifiers[0].found, true);
  assert.equal(p.identifiers[0].normalised, true, 'an exact match of a normalised form, and the reader is told');
});

test('presence: an empty identifier cell is no verdicts, not a failed one', () => {
  // "Nothing to check" and "checked and not found" are different answers, and
  // the editor must not draw the first as the second.
  const index = buildEvidenceIndex(TWO_IDS);
  const p = presenceForRows(index, [
    { id: 'r1', resourceName: 'Anti-parkin', identifier: '' }
  ]).get('r1');

  assert.deepEqual(p.identifiers, []);
  assert.deepEqual(p.identifiersNotFound, []);
  assert.equal(p.viaIdentifier, false);
});

test('presence: every identifier can be corroborated', () => {
  const index = buildEvidenceIndex(
    'Plasmid pAAV-hSyn (Addgene #50465) was used; see also 10.5281/zenodo.123.'
  );
  const p = presenceForRows(index, [
    { id: 'r1', resourceName: 'pAAV-hSyn', identifier: 'Addgene #50465, 10.5281/zenodo.123' }
  ]).get('r1');

  assert.deepEqual(p.identifiers.map((i) => i.found), [true, true]);
  assert.deepEqual(p.identifiersNotFound, []);
});

test('presence: rows are keyed by id, and an empty set is not an error', () => {
  const index = buildEvidenceIndex(MANUSCRIPT);
  assert.equal(presenceForRows(index, []).size, 0);
  assert.equal(presenceForRows(index, null).size, 0);
});
