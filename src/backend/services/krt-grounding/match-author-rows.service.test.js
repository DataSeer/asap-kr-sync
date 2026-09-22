/**
 * Tests for the deterministic author-KRT matcher.
 *
 * The invariants that matter most:
 *   - an author row is NEVER mutated, and a non-empty author field is never
 *     proposed for change
 *   - a row nobody detected comes back `not_detected`, not dropped
 *   - identifier beats alias beats name, and type mismatches don't match
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  matchAuthorRows,
  matchStrength,
  candidateNames,
  compareWithCandidates,
  valuesConflict
} = require('./match-author-rows.service');

const candidate = (over = {}) => ({
  resourceType: 'Software/code',
  resourceName: 'CellProfiler',
  identifier: '',
  source: '',
  newReuse: 'reuse',
  confidence: 0.8,
  evidence: { quote: 'analysed in CellProfiler', offset: 10, section: 'Methods', match: 'exact' },
  detectorMeta: {},
  ...over
});

const authorRow = (over = {}) => ({
  id: 'row-1',
  resourceType: 'Software/code',
  resourceName: 'CellProfiler',
  identifier: '',
  source: '',
  newReuse: '',
  additionalInformation: '',
  ...over
});

test('confirms a row matched by identifier', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'RRID:SCR_007358', source: 'cellprofiler.org', newReuse: 'reuse' })],
    [candidate({ identifier: 'RRID:SCR_007358' })]
  );
  assert.equal(outcomes[0].outcome, 'confirmed');
  assert.equal(outcomes[0].matchedBy, 'identifier');
  assert.deepEqual(outcomes[0].matchedRefs, [0]);
  assert.equal(outcomes[0].evidence.section, 'Methods');
});

test('reports not_detected when nothing matches — the row is kept, not dropped', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceName: 'Bioplex Multiplex Immunoassay' })],
    [candidate({ resourceName: 'ImageJ' })]
  );
  assert.equal(outcomes.length, 1, 'the author row survives');
  assert.equal(outcomes[0].outcome, 'not_detected');
  assert.equal(outcomes[0].matchedBy, null);
  assert.deepEqual(outcomes[0].matchedRefs, []);
  assert.equal(outcomes[0].resourceName, 'Bioplex Multiplex Immunoassay');
});

test('matches through an alias — the naming-variant case', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceName: 'Cell Profiler', newReuse: 'reuse', source: 'cellprofiler.org' })],
    [candidate({ resourceName: 'CellProfiler', detectorMeta: { aliases: ['Cell Profiler'] } })]
  );
  assert.equal(outcomes[0].outcome, 'confirmed');
  assert.ok(['alias', 'name'].includes(outcomes[0].matchedBy));
});

test('matches software across a version suffix', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceName: 'Fiji', newReuse: 'reuse', source: 'fiji.sc' })],
    [candidate({ resourceName: 'Fiji 2.9.0' })]
  );
  assert.equal(outcomes[0].outcome, 'confirmed');
});

test('does not match across resource types', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Dataset', resourceName: 'CellProfiler' })],
    [candidate({ resourceType: 'Software/code', resourceName: 'CellProfiler' })]
  );
  assert.equal(outcomes[0].outcome, 'not_detected');
});

test('a type-less candidate (identifier sweep) may still match', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'RRID:SCR_002285' })],
    [candidate({ resourceType: '', resourceName: '', identifier: 'RRID:SCR_002285' })]
  );
  assert.equal(outcomes[0].matchedBy, 'identifier');
});

test('flags incomplete and proposes only the EMPTY author fields', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ source: 'cellprofiler.org', identifier: '', newReuse: 'reuse' })],
    [candidate({ identifier: 'RRID:SCR_007358', source: 'SOMETHING ELSE', newReuse: 'new' })]
  );
  const outcome = outcomes[0];
  assert.equal(outcome.outcome, 'incomplete');
  assert.deepEqual(outcome.missingFields, ['identifier'], 'only the empty field is proposed');
  assert.equal(outcome.foundValues.identifier, 'RRID:SCR_007358');
  assert.equal(outcome.foundValues.source, undefined, 'a filled author field is never proposed');
  assert.equal(outcome.foundValues.newReuse, undefined);
});

test('never proposes a value no candidate carried', () => {
  const { missingFields, foundValues } = compareWithCandidates(
    authorRow(),
    [{ candidate: candidate({ identifier: '', source: '', newReuse: '' }) }]
  );
  assert.deepEqual(missingFields, []);
  assert.deepEqual(foundValues, {});
});

test('prefers the highest-confidence supplier for a fill', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow()],
    [
      candidate({ source: 'low-confidence.org', confidence: 0.4 }),
      candidate({ source: 'high-confidence.org', confidence: 0.95 })
    ]
  );
  assert.equal(outcomes[0].foundValues.source, 'high-confidence.org');
});

test('identifier match outranks a name match on a different candidate', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceName: 'CellProfiler', identifier: 'RRID:SCR_007358' })],
    [
      candidate({ resourceName: 'CellProfiler', identifier: '' }),
      candidate({ resourceName: 'Totally Different', identifier: 'RRID:SCR_007358' })
    ]
  );
  assert.equal(outcomes[0].matchedBy, 'identifier');
  assert.deepEqual(outcomes[0].matchedRefs.sort(), [0, 1]);
});

test('reports candidates that matched no author row (the "author missed this" set)', () => {
  const { unmatchedCandidateRefs, stats } = matchAuthorRows(
    [authorRow({ resourceName: 'CellProfiler' })],
    [candidate({ resourceName: 'CellProfiler' }), candidate({ resourceName: 'ImageJ' })]
  );
  assert.deepEqual(unmatchedCandidateRefs, [1]);
  assert.equal(stats.unmatchedCandidates, 1);
});

test('prefers exact evidence over partial when reporting', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'RRID:SCR_007358' })],
    [
      candidate({ identifier: 'RRID:SCR_007358', evidence: { quote: 'a', offset: 1, section: 'Discussion', match: 'partial' } }),
      candidate({ identifier: 'RRID:SCR_007358', evidence: { quote: 'b', offset: 2, section: 'Methods', match: 'exact' } })
    ]
  );
  assert.equal(outcomes[0].evidence.match, 'exact');
  assert.equal(outcomes[0].evidence.section, 'Methods');
});

test('candidateNames folds merged contributors in as aliases', () => {
  const names = candidateNames(candidate({
    resourceName: 'Fiji',
    mergedFrom: [{ originalItem: { resourceName: 'ImageJ/FIJI' } }]
  }), 'software/code');
  assert.ok(names.aliases.length > 0);
});

test('empty inputs are handled', () => {
  const { outcomes, unmatchedCandidateRefs, stats } = matchAuthorRows([], []);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(unmatchedCandidateRefs, []);
  assert.equal(stats.authorRows, 0);
});

test('no-KRT mode: every candidate is unmatched, no outcomes', () => {
  const { outcomes, unmatchedCandidateRefs } = matchAuthorRows([], [candidate(), candidate()]);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(unmatchedCandidateRefs, [0, 1]);
});

test('matchStrength returns null when there is nothing to compare', () => {
  assert.equal(
    matchStrength('', '', 'software/code', {
      names: candidateNames(candidate(), 'software/code'),
      candidate: candidate()
    }),
    null
  );
});

/**
 * Version stripping removes any trailing 1-4 digit number, which is right for
 * "Prism 9" and wrong for "Alexa Fluor 568". Before this gate, the two Alexa
 * conjugates both normalized to "alexa fluor", the matcher reported the row
 * confirmed, and grounding offered to fill the 488 antibody's RRID into the
 * author's 568 row — a wrong value wearing grounding provenance.
 */
test('version stripping never applies outside software: two Alexa conjugates do not match', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Antibody', resourceName: 'Alexa Fluor 568', identifier: '', source: '' })],
    [candidate({ resourceType: 'Antibody', resourceName: 'Alexa Fluor 488', identifier: 'RRID:AB_2534069', source: 'Thermo Fisher' })]
  );
  assert.equal(outcomes[0].outcome, 'not_detected');
  assert.equal(outcomes[0].matchedBy, null);
  assert.deepEqual(outcomes[0].foundValues, {}, 'must not propose the other conjugate\'s identifier');
});

test('version stripping never applies outside software: strain numbers stay significant', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Experimental model', resourceName: 'Drd1a-tdTomato line 6', identifier: '', source: '' })],
    [candidate({ resourceType: 'Experimental model', resourceName: 'Drd1a-tdTomato line 5', identifier: 'RRID:IMSR_JAX:016204', source: 'JAX' })]
  );
  assert.equal(outcomes[0].outcome, 'not_detected');
});

test('software still matches version-insensitively', () => {
  for (const [rowName, candName] of [['Fiji 2.9.0', 'Fiji'], ['Prism 9', 'Prism'], ['MATLAB R2019b', 'MATLAB']]) {
    const { outcomes } = matchAuthorRows(
      [authorRow({ resourceType: 'Software/code', resourceName: rowName, identifier: '', source: '' })],
      [candidate({ resourceType: 'Software/code', resourceName: candName, identifier: 'RRID:SCR_002285', source: 'OSS' })]
    );
    assert.equal(outcomes[0].matchedBy, 'name', `${rowName} should still match ${candName}`);
  }
});

/**
 * Authors write the packaged construct; the paper names the component. Strict
 * name equality missed every one of these — a whole manuscript in the demo
 * corpus scored 0 confirmed out of 45 rows this way, while GCaMP6f appeared in
 * its text six times.
 */
test('partial name match: the paper\'s component name inside the author\'s construct', () => {
  const cases = [
    ['AAV5.CaMKII.GCaMP6f.WPRE.SV40', 'GCaMP6f'],
    ['AAV8.CaMKII.ChRmine.mScarlet.Kv2.1.WPRE', 'ChRmine'],
    ['rabbit anti-RFP', 'anti-RFP']
  ];
  for (const [rowName, candName] of cases) {
    const { outcomes } = matchAuthorRows(
      [authorRow({ resourceType: 'Virus strain', resourceName: rowName, identifier: '', source: '' })],
      [candidate({ resourceType: 'Virus strain', resourceName: candName, identifier: 'Addgene_100837', source: 'Addgene' })]
    );
    assert.equal(outcomes[0].outcome, 'partial', `${rowName} ~ ${candName}`);
    assert.equal(outcomes[0].matchedBy, 'partial_name');
  }
});

test('a partial match never proposes a fill', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Virus strain', resourceName: 'AAV5.CaMKII.GCaMP6f.WPRE.SV40', identifier: '', source: '' })],
    [candidate({ resourceType: 'Virus strain', resourceName: 'GCaMP6f', identifier: 'Addgene_100837', source: 'Addgene' })]
  );
  // The bare protein's identifier is not the packaged virus's identifier.
  assert.deepEqual(outcomes[0].foundValues, {});
  assert.deepEqual(outcomes[0].missingFields, []);
  assert.deepEqual(outcomes[0].conflicts, []);
});

test('a partial match still carries evidence — that is the point of the tier', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Virus strain', resourceName: 'AAV5.CaMKII.GCaMP6f.WPRE.SV40', identifier: '', source: '' })],
    [candidate({
      resourceType: 'Virus strain',
      resourceName: 'GCaMP6f',
      evidence: { quote: 'injected with GCaMP6f', offset: 5, section: 'Methods', match: 'exact' }
    })]
  );
  assert.equal(outcomes[0].evidence.quote, 'injected with GCaMP6f');
});

test('partial matching does not fire on generic or short names', () => {
  const cases = [
    ['Cell line', 'HEK293 cell line', 'cell line'],   // every token generic
    ['Antibody', 'anti-GFP Alexa 488 conjugate', 'GFP'] // single short token
  ];
  for (const [type, rowName, candName] of cases) {
    const { outcomes } = matchAuthorRows(
      [authorRow({ resourceType: type, resourceName: rowName, identifier: '', source: '' })],
      [candidate({ resourceType: type, resourceName: candName, identifier: 'X_1', source: 'Y' })]
    );
    assert.equal(outcomes[0].outcome, 'not_detected', `${rowName} must not match ${candName}`);
  }
});

test('a stronger match outranks a partial one, and only the strong one fills', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Software/code', resourceName: 'CellProfiler', identifier: '', source: '' })],
    [
      candidate({ resourceName: 'CellProfiler pipeline runner', identifier: 'WRONG_1', source: 'wrong' }),
      candidate({ resourceName: 'CellProfiler', identifier: 'RRID:SCR_007358', source: 'cellprofiler.org' })
    ]
  );
  assert.equal(outcomes[0].matchedBy, 'name');
  assert.equal(outcomes[0].foundValues.identifier, 'RRID:SCR_007358', 'fill must come from the exact-name match');
  assert.notEqual(outcomes[0].foundValues.source, 'wrong');
});

test('stats count partial separately instead of folding it into notDetected', () => {
  const { stats } = matchAuthorRows(
    [authorRow({ resourceType: 'Virus strain', resourceName: 'AAV5.CaMKII.GCaMP6f.WPRE.SV40', identifier: '', source: '' })],
    [candidate({ resourceType: 'Virus strain', resourceName: 'GCaMP6f' })]
  );
  assert.equal(stats.partial, 1);
  assert.equal(stats.notDetected, 0);
});

test('a matching identifier still wins even when the names differ completely', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ resourceType: 'Antibody', resourceName: 'Alexa Fluor 568', identifier: 'RRID:AB_143011', source: '' })],
    [candidate({ resourceType: 'Antibody', resourceName: 'goat anti-rabbit IgG', identifier: 'RRID:AB_143011', source: 'Thermo Fisher' })]
  );
  assert.equal(outcomes[0].matchedBy, 'identifier');
});

// ── Conflicts ───────────────────────────────────────────────────────────────
// SOURCE and IDENTIFIER are validation ERRORS when empty, so any KRT reaching
// this module has them filled on every row — which makes "empty cell" fills
// almost unreachable. Disagreements are what this comparison is really for.

test('flags a real discrepancy the author and the manuscript disagree on', () => {
  // From the demo corpus: same RRID, different strain code.
  const { outcomes } = matchAuthorRows(
    [authorRow({
      resourceType: 'Experimental model: Organism/strain',
      resourceName: 'Sprague-Dawley rats',
      identifier: 'strain code: 400, RRID: RGD_734476',
      source: 'Charles River Laboratories',
      newReuse: 'new'
    })],
    [candidate({
      resourceType: 'Experimental model: Organism/strain',
      resourceName: 'Sprague-Dawley rats',
      identifier: 'strain code: 001, RRID: RGD_734476',
      source: 'Charles River Laboratories',
      newReuse: 'new'
    })],
    // The paper prints this. Only what it prints may contradict the author.
    (v) => ['strain code: 001', 'RRID: RGD_734476'].includes(v)
  );
  assert.equal(outcomes[0].outcome, 'incomplete');
  assert.equal(outcomes[0].conflicts.length, 1);
  assert.equal(outcomes[0].conflicts[0].field, 'identifier');
  assert.match(outcomes[0].reason, /manuscript gives identifier/);
});

test('a conflict never proposes a change — the author value stands', () => {
  // The predicate is what the PAPER prints: the candidate's catalogue number,
  // not the author's. `() => true` would describe a manuscript printing both,
  // and a paper that prints the author's own value corroborates the row.
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'Cat #: 657012', source: 'Millipore', newReuse: 'reuse' })],
    [candidate({ identifier: 'Cat #: 999999', source: 'Millipore', newReuse: 'reuse' })],
    (value) => String(value).includes('999999')
  );
  assert.equal(outcomes[0].conflicts.length, 1);
  assert.deepEqual(outcomes[0].missingFields, [], 'nothing is proposed for an EDIT');
  assert.deepEqual(outcomes[0].foundValues, {});
});

test('formatting differences are not conflicts', () => {
  assert.equal(valuesConflict('identifier', 'RRID: AB_2201407', 'RRID:AB_2201407'), false);
  assert.equal(valuesConflict('source', 'Millipore', 'millipore'), false);
  assert.equal(valuesConflict('identifier', 'Cat#: 657012', 'cat # 657012'), false);
});

test('one value merely being more complete is not a conflict', () => {
  assert.equal(valuesConflict('identifier', 'Cat #: 657012, RRID: AB_2201407', 'RRID: AB_2201407'), false);
  assert.equal(valuesConflict('identifier', 'RRID: AB_2201407', 'Cat #: 657012, RRID: AB_2201407'), false);
  assert.equal(valuesConflict('source', 'Millipore', 'MilliporeSigma'), false);
});

test('an identifier type present on only one side is not a conflict', () => {
  // A DOI on one side and an RRID on the other say different things about the
  // same resource; neither contradicts the other.
  assert.equal(valuesConflict('identifier', 'RRID: AB_1', '10.5281/zenodo.1'), false);
});

test('new/reuse can never reach the conflict check at all', () => {
  // It is not comparable — no detector reads new-versus-reuse from the
  // manuscript — so the guard is the COMPARABLE_FIELDS list, not a special case
  // inside valuesConflict. Asserting the old special case kept a dead branch
  // looking live: the next person to add a comparable field would have
  // inherited a rule nothing applied.
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'RRID:AB_1', newReuse: 'reuse' })],
    [candidate({ identifier: 'RRID:AB_1', newReuse: 'new' })]
  );
  assert.deepEqual(outcomes[0].conflicts, [], 'the manuscript never says new-versus-reuse');
});

test('new/reuse is not offered as a fill either, even for an empty cell', () => {
  // The other half of the same rule, and the one that is easy to lose: every
  // detector hard-codes a new/reuse default, so a "found value" for it is our
  // own default handed back. Filling an empty cell from it would invent data
  // and dress it in grounding provenance.
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'RRID:AB_1', newReuse: '', source: '' })],
    [candidate({ identifier: 'RRID:AB_1', newReuse: 'new', source: 'Abcam' })]
  );

  assert.ok(!outcomes[0].missingFields.includes('newReuse'), 'new/reuse must never be proposed');
  assert.equal(outcomes[0].foundValues.newReuse, undefined, 'and no value for it may be carried');
  // Source is the contrast: proposing a vendor for an empty cell IS useful, and
  // is not an accusation. Only contradicting the author about it was wrong.
  assert.ok(outcomes[0].missingFields.includes('source'), 'source is still offered');
});

test('an empty side is never a conflict', () => {
  assert.equal(valuesConflict('identifier', '', 'RRID: AB_1'), false);
  assert.equal(valuesConflict('identifier', 'RRID: AB_1', ''), false);
});

test('a complete, agreeing row is still confirmed', () => {
  const { outcomes } = matchAuthorRows(
    [authorRow({ identifier: 'RRID:SCR_007358', source: 'cellprofiler.org', newReuse: 'reuse' })],
    [candidate({ identifier: 'RRID:SCR_007358', source: 'cellprofiler.org', newReuse: 'reuse' })]
  );
  assert.equal(outcomes[0].outcome, 'confirmed');
  assert.equal(outcomes[0].conflicts.length, 0);
});

// ── what may contradict the author ──────────────────────────────────────────
// This module checks the KRT against the PDF, so it may only disagree with the
// author about things genuinely read FROM the PDF and genuinely comparable.

test('a differing identifier IS an incoherence', () => {
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'RRID:SCR_111111' }),
    [{ candidate: candidate({ identifier: 'RRID:SCR_999999' }) }],
    (value) => String(value).includes('SCR_999999')
  );

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'identifier');
});

// ── rows that share a name ──────────────────────────────────────────────────
// Several author rows routinely carry ONE resource name — three "CHCHD2
// antibody" rows, one per clone — and the candidate pool is matched by name, so
// a sibling's identifier lands in this row's pool. Observed on RE2-020529-009:
// nine conflicts, every one a row the paper prints verbatim.

/**
 * The manuscript's antibody table, one line per clone — the shape that
 * produced the false conflicts on RE2-020529-009.
 */
const CHCHD2_TABLE = [
  '| chchd2 antibody | Proteintech 66302-1-ig | AB_2881685 |',
  '| chchd2 antibody | Prestige antibodies hPA027407 | AB_10959659 |',
  '| chchd2 antibody | Proteintech 19424-1-AP | AB_10638907 |'
];

/** Printed anywhere in the document. */
const printedIn = (lines) => (value) => lines.join('\n').includes(String(value).trim());

/** Printed on the same LINE as this row's own source — the real test. */
const printedWithRowIn = (lines) => (value, row) => lines.some(
  (line) => line.includes(String(value).trim())
    && String(row?.source || '').trim() !== ''
    && line.includes(String(row.source).trim())
);

test('a row the paper prints verbatim is not contradicted by its sibling', () => {
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'AB_2881685', source: 'Proteintech 66302-1-ig' }),
    // A sibling clone's candidate, in this row's pool because the names match.
    [{ candidate: candidate({ identifier: 'HPA027407, AB_10959659' }) }],
    printedIn(CHCHD2_TABLE),
    printedWithRowIn(CHCHD2_TABLE)
  );

  assert.deepEqual(conflicts, [], 'the paper prints this row verbatim, on its own line');
});

// ── swapped identifiers must NOT be swallowed ───────────────────────────────
// The reason corroboration is scoped to the row and not to the document: when
// two rows have each other's identifiers, BOTH values are in the text, and a
// document-wide check would call both rows corroborated and report nothing.

test('an identifier that belongs to another row is still a conflict', () => {
  // The author swapped two identifiers. The paper describes both resources
  // correctly, so BOTH values are in the document — which is the trap: a
  // document-wide "is it printed?" calls the row corroborated and says nothing.
  const paper = [
    '| chchd2 antibody | Proteintech 66302-1-ig | AB_2881685 |',
    '| chchd2 antibody | Proteintech 19424-1-AP | AB_10638907 |'
  ];
  // This row is the FIRST clone, carrying the SECOND clone's RRID.
  const swapped = authorRow({
    resourceName: 'chchd2 antibody', source: 'Proteintech 66302-1-ig', identifier: 'AB_10638907'
  });

  assert.equal(printedIn(paper)('AB_10638907'), true, 'the wrong value IS in the document');
  assert.equal(printedWithRowIn(paper)('AB_10638907', swapped), false, "but not on this row's line");

  const { conflicts } = compareWithCandidates(
    swapped,
    [{ candidate: candidate({ resourceName: 'chchd2 antibody', identifier: 'AB_2881685' }) }],
    printedIn(paper),
    printedWithRowIn(paper)
  );

  assert.equal(conflicts.length, 1, 'that RRID sits beside the other clone, not beside this source');
  assert.equal(conflicts[0].field, 'identifier');
  assert.equal(conflicts[0].manuscriptValue, 'AB_2881685');
});

test('a wrong identifier the paper never prints is a conflict too', () => {
  const paper = ['We used the AtP5A1 antibody (Proteintech 66037-1-ig, AB_11044196) here.'];
  const { conflicts } = compareWithCandidates(
    authorRow({ resourceName: 'AtP5A1 antibody', source: 'Proteintech 66037-1-ig', identifier: 'AB_99999999' }),
    [{ candidate: candidate({ resourceName: 'AtP5A1 antibody', identifier: 'AB_11044196' }) }],
    printedIn(paper),
    printedWithRowIn(paper)
  );

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].manuscriptValue, 'AB_11044196');
});

test('a row with nothing to anchor on is never corroborated', () => {
  // No source, so the paper cannot be said to print the value AS THIS ROW's.
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'AB_2881685', source: '' }),
    [{ candidate: candidate({ identifier: 'AB_10959659' }) }],
    printedIn(CHCHD2_TABLE),
    printedWithRowIn(CHCHD2_TABLE)
  );

  assert.equal(conflicts.length, 1, 'reporting too much beats silently dropping a swap');
});

test('...but a row the paper contradicts still is', () => {
  // The RRID matches and the strain code does not: the disagreement the module
  // exists to surface survives, because EVERY part must be printed with the row.
  const paper = ['| Sprague-Dawley rats | Charles River | strain code: 001, RRID: RGD_734476 |'];
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'strain code: 400, RRID: RGD_734476', source: 'Charles River' }),
    [{ candidate: candidate({ identifier: 'strain code: 001, RRID: RGD_734476' }) }],
    printedIn(paper),
    printedWithRowIn(paper)
  );

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'identifier');
});

test('with no manuscript predicate nothing is corroborated, and nothing conflicts', () => {
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'AB_2881685' }),
    [{ candidate: candidate({ identifier: 'AB_10959659' }) }],
    undefined,
    undefined
  );

  assert.deepEqual(conflicts, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Only the manuscript may contradict the author
// ─────────────────────────────────────────────────────────────────────────────

test('a candidate value the manuscript does not print raises nothing', () => {
  // The reported bug. An identifier-scan candidate carries the whole enrichment
  // entry, so this URL is something the curated list knows — not something the
  // paper said. Quoting it as `manuscriptValue` told authors their correct rows
  // disagreed with a source that never mentioned them.
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'RRID:SCR_014269' }),
    [{ candidate: candidate({ identifier: 'RRID:SCR_014269 ; http://ric.uthscsa.edu/mango/' }) }],
    (v) => v === 'RRID:SCR_014269'
  );

  assert.deepEqual(conflicts, [], 'the only value the paper prints agrees with the author');
});

test('the parts a manuscript DOES print still contradict', () => {
  // The other half: filtering must not neuter the check. The paper prints a
  // different strain code, and that is exactly what the curator needs.
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'strain code: 400, RRID: RGD_734476' }),
    [{ candidate: candidate({ identifier: 'strain code: 001, RRID: RGD_734476' }) }],
    (v) => ['strain code: 001', 'RRID: RGD_734476'].includes(v)
  );

  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].manuscriptValue, /strain code: 001/);
});

test('with no manuscript to check against, nothing is asserted', () => {
  // Omitting the predicate must not fall back to comparing candidate values —
  // that fallback IS the bug, and a silent default would restore it.
  const { conflicts } = compareWithCandidates(
    authorRow({ identifier: 'RRID:SCR_111111' }),
    [{ candidate: candidate({ identifier: 'RRID:SCR_999999' }) }]
  );

  assert.deepEqual(conflicts, []);
});

test('a differing SOURCE is not', () => {
  // Detectors do populate source — the repository for a dataset, the supplier
  // for a material — but that is inferred from where a thing lives, not
  // asserted by the manuscript about the author's row. Telling a curator their
  // supplier contradicts the paper is not a finding.
  const { conflicts } = compareWithCandidates(
    authorRow({ source: 'Addgene' }),
    [{ candidate: candidate({ source: 'Zenodo' }) }]
  );

  assert.deepEqual(conflicts, []);
});

test('a differing NEW/REUSE is not, and is not offered as a fill either', () => {
  // No detector reads new-versus-reuse from the manuscript; every one
  // hard-codes a default. A "found value" for it was our own default handed
  // back, so both the conflict and the fill were invented.
  const { conflicts, missingFields, foundValues } = compareWithCandidates(
    authorRow({ newReuse: 'new' }),
    [{ candidate: candidate({ newReuse: 'reuse' }) }]
  );

  assert.deepEqual(conflicts, []);
  assert.ok(!missingFields.includes('newReuse'));
  assert.equal(foundValues.newReuse, undefined);
});

test('an empty source is still offered as a fill', () => {
  // Excluded from conflicts, kept as a fill: proposing a repository for an
  // empty cell is useful and is not an accusation.
  const { missingFields, foundValues } = compareWithCandidates(
    authorRow({ source: '' }),
    [{ candidate: candidate({ source: 'Zenodo' }) }]
  );

  assert.ok(missingFields.includes('source'));
  assert.equal(foundValues.source, 'Zenodo');
});
