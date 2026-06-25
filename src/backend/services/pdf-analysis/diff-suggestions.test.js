/**
 * Tests for the suggestion diff service.
 * Run with: node --test src/backend/services/pdf-analysis/diff-suggestions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mergeDetections } = require('./merge-detections.service');
const { computeSuggestions, parseSuggestionId, isLossyRename, buildSuppressionFilter } = require('./diff-suggestions.service');

const itemAddRow = (overrides = {}) => ({
  type: 'add_row',
  data: {
    resourceType: 'Software/code',
    resourceName: 'Python',
    source: 'https://python.org',
    identifier: '',
    newReuse: 'reuse',
    additionalInformation: '',
    ...overrides
  },
  confidence: 0.8
});

test('no overlap → all add_row suggestions', () => {
  const gen = mergeDetections([{ source: 'a', items: [itemAddRow({ resourceName: 'New Tool', identifier: 'id-1' })] }]);
  const sugs = computeSuggestions(gen, []);
  assert.equal(sugs.length, 1);
  assert.equal(sugs[0].type, 'add_row');
  assert.ok(sugs[0].id.startsWith('add:'));
});

test('Generated identical to KRT → no suggestions', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x' })] }
  ]);
  const krt = [{
    resourceType: 'Software/code', resourceName: 'Python', source: 'https://python.org',
    identifier: '10.1234/x', newReuse: 'reuse', additionalInformation: ''
  }];
  assert.deepEqual(computeSuggestions(gen, krt), []);
});

test('Same dedup_key + different additional info → NO edit suggestion (column off-limits)', () => {
  // Per ASAP: AI-driven changes never write to ADDITIONAL INFORMATION.
  // The detector blurb is surfaced as `suggestion.context` only.
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x', additionalInformation: 'v3.10' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'Python', source: 'https://python.org',
    identifier: '10.1234/x', newReuse: 'reuse', additionalInformation: ''
  }];
  assert.deepEqual(computeSuggestions(gen, krt), []);
});

test('B2: detector "Fiji" matches author "Fiji 2.9.0" (version stripped) → no add', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Fiji', identifier: '', source: '' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'Fiji 2.9.0', source: '',
    identifier: '', newReuse: 'new', additionalInformation: ''
  }];
  assert.deepEqual(computeSuggestions(gen, krt), []);
});

test('B2: RRID embedded in author name matches detector identifier → no add', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'ImageJ', identifier: 'RRID:SCR_003070', source: '' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'ImageJ (RRID:SCR_003070)', source: '',
    identifier: '', newReuse: 'reuse', additionalInformation: ''
  }];
  // The duplicate must NOT produce an add_row; matching on the name-embedded RRID
  // may still propose filling the empty identifier column (desirable).
  const sugs = computeSuggestions(gen, krt);
  assert.equal(sugs.filter(s => s.type === 'add_row').length, 0);
});

test('Rejected add → suggestion suppressed', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'New Tool', identifier: 'id-1' })] }
  ]);
  const dk = gen[0].dedupKey;
  assert.deepEqual(computeSuggestions(gen, [], new Set([dk])), []);
});

test('Rejected column → that column suppressed, others kept', () => {
  // Generated differs from user in source AND identifier; rejecting `source`
  // should leave an identifier edit behind. (additionalInformation is no
  // longer in the editable set, so we use `identifier` as the surviving
  // column for this test instead.)
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({
      resourceName: 'Python', identifier: 'RRID:SCR_008394',
      source: 'https://other.org'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'Python', source: 'https://python.org',
    identifier: '', newReuse: 'reuse', additionalInformation: ''
  }];
  const dk = gen[0].dedupKey;
  const rejCols = new Map([[dk, new Set(['source'])]]);
  const sugs = computeSuggestions(gen, krt, new Set(), rejCols);
  assert.equal(sugs.length, 1);
  assert.equal(sugs[0].data.column, 'identifier');
});

test('Generator value is empty → no edit suggested (does not blank user data)', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x', additionalInformation: '' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'Python', source: 'https://python.org',
    identifier: '10.1234/x', newReuse: 'reuse', additionalInformation: 'lots of notes'
  }];
  assert.deepEqual(computeSuggestions(gen, krt), []);
});

test('Suggestion IDs are deterministic across runs', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x' })] }
  ]);
  const ids1 = computeSuggestions(gen, []).map(s => s.id);
  const ids2 = computeSuggestions(gen, []).map(s => s.id);
  assert.deepEqual(ids1, ids2);
});

test('parseSuggestionId handles add', () => {
  assert.deepEqual(
    parseSuggestionId('add:foo|bar|baz'),
    { kind: 'add', dedupKey: 'foo|bar|baz' }
  );
});

test('parseSuggestionId handles edit', () => {
  assert.deepEqual(
    parseSuggestionId('edit:foo|bar|baz:resourceName'),
    { kind: 'edit', dedupKey: 'foo|bar|baz', column: 'resourceName' }
  );
});

test('parseSuggestionId returns null for garbage', () => {
  assert.equal(parseSuggestionId('garbage'), null);
  assert.equal(parseSuggestionId(''), null);
  assert.equal(parseSuggestionId(null), null);
});

test('mergedFrom carries detector contributions', () => {
  const gen = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({ resourceName: 'Python' })] },
    { source: 'pdf_analysis',       items: [itemAddRow({ resourceName: 'PYTHON' })] }
  ]);
  const sugs = computeSuggestions(gen, []);
  assert.equal(sugs[0].mergedFrom.length, 2);
});

// ---- alias-aware matching against the user's KRT ----------------------------
// dedupKey-equality lookup misses these. After the matcher rewrite, generated
// rows pair with user rows via identifier-token, opaque-id, or normalized-name
// aliases — so an "edit" surfaces instead of a spurious "add".

test('alias match: user has name-only, detector has identifier → edit not add', () => {
  const gen = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({
      resourceName: 'ImageJ', identifier: 'RRID:SCR_003070', source: 'https://imagej.net'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'ImageJ',
    identifier: '', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.ok(sugs.every(s => s.type === 'edit'), `expected only edits, got ${sugs.map(s => s.type)}`);
  assert.ok(sugs.some(s => s.data.column === 'identifier'));
  assert.equal(sugs[0].matchedKrtRowId, 'r1');
});

test('alias match: user has identifier-only, detector has name → edit not add', () => {
  const gen = mergeDetections([
    { source: 'datasets_detection', items: [itemAddRow({
      resourceType: 'Dataset', resourceName: 'Allen Brain Atlas', identifier: '10.5281/zenodo.1', newReuse: 'reuse'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Dataset', resourceName: '',
    identifier: '10.5281/zenodo.1', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  // It's a match (by identifier) → NOT surfaced as an add row...
  assert.ok(sugs.every(s => s.type !== 'add_row'));
  // ...and RESOURCE NAME edits are no longer suggested for existing rows,
  // even to fill an empty name.
  assert.ok(sugs.every(s => s.data?.column !== 'resourceName'));
});

test('alias match: identifier formats differ but normalize equal', () => {
  const gen = mergeDetections([
    { source: 'materials_detection', items: [itemAddRow({
      resourceType: 'Other', resourceName: 'Anti-tubulin', identifier: 'RRID: AB_357520',
      newReuse: 'reuse', source: '', additionalInformation: ''
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Other', resourceName: 'Anti-tubulin',
    identifier: 'AB_357520', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  // Opaque "AB_357520" matches the rrid:ab_357520 token's value, so it's a
  // match (not an "add"). The identifier values normalize equal, so no edit
  // suggestion on identifier. Other fields are equal too → empty list.
  assert.deepEqual(sugs, []);
});

test('alias match works for Protocol resource type', () => {
  const gen = mergeDetections([
    { source: 'protocols_detection', items: [itemAddRow({
      resourceType: 'Protocol',
      resourceName: 'Hippocampal Primary Neuronal Culture',
      identifier: '10.17504/protocols.io.ewov1qxr2gr2/v1',
      newReuse: 'reuse'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Protocol',
    resourceName: 'Hippocampal Primary Neuronal Culture',
    identifier: '', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.ok(sugs.every(s => s.type === 'edit'));
  assert.ok(sugs.some(s => s.data.column === 'identifier'));
});

test('alias matcher refuses cross-type matches', () => {
  // Same name + identifier but different resourceType → no match, surface as add.
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({
      resourceType: 'Software/code', resourceName: 'Python', identifier: 'id-x'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Dataset', resourceName: 'Python',
    identifier: 'id-x', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.ok(sugs.some(s => s.type === 'add_row'));
});

test('alias matcher matches across newReuse difference', () => {
  // Same identifier + name but newReuse mismatch → still a match. The user
  // may have classified a resource as NEW (they generated it) while the
  // detector cites the same identifier as reuse from references; both refer
  // to the same row. newReuse is not editable so no edit is emitted either.
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Tool', identifier: 'id-1', newReuse: 'new' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'Tool',
    identifier: 'id-1', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.ok(!sugs.some(s => s.type === 'add_row'));
});

// ───────────────────────────────────────────────────────────────────────────
// Lossy-rename guard (suppresses misleading resourceName EDIT suggestions
// from the curated DB's canonical-name picks)
// ───────────────────────────────────────────────────────────────────────────

test('isLossyRename: cosmetic-only diff is lossy', () => {
  assert.equal(isLossyRename('Fiji', 'fiji'), true);
  assert.equal(isLossyRename('Image J', 'ImageJ'), true);
  assert.equal(isLossyRename('  Python ', 'Python'), true);
});

test('isLossyRename: substring rename is lossy', () => {
  assert.equal(isLossyRename('Sprague-Dawley rats', 'Sprague-Dawley'), true);
  assert.equal(isLossyRename('Allen Brain Atlas', 'Allen Brain'), true);
});

test('isLossyRename: dropping qualifier is lossy', () => {
  assert.equal(isLossyRename('Rabbit anti-TH', 'Anti-TH'), true);
  assert.equal(isLossyRename('Monoclonal Mouse Anti-tubulin', 'Anti-tubulin'), true);
});

test('isLossyRename: zero-overlap rename is suspicious (different entity)', () => {
  // Curated DB grouped the antibody and the target under one entry.
  assert.equal(isLossyRename('Sheep anti-TH', 'tyrosine hydroxylase'), true);
});

test('isLossyRename: partial paraphrase that drops more than it adds is lossy', () => {
  // Old uniquely has {monoclonal, mouse, anti}; new uniquely has {beta} —
  // 3 dropped vs 1 added → net info loss.
  assert.equal(isLossyRename('Monoclonal Mouse Anti-tubulin-βIII', 'a-Tubulin beta III'), true);
});

test('isLossyRename: empty new name is lossy', () => {
  assert.equal(isLossyRename('Fiji', ''), true);
  assert.equal(isLossyRename('Fiji', '   '), true);
});

test('isLossyRename: empty old name allows any rename', () => {
  assert.equal(isLossyRename('', 'Fiji'), false);
  assert.equal(isLossyRename(null, 'Fiji'), false);
});

test('isLossyRename: meaningful enrichment is NOT lossy', () => {
  // New name adds info (more tokens, none lost).
  assert.equal(isLossyRename('Anti-TH', 'Rabbit anti-TH (clone TH2)'), false);
  // Different but overlapping naming convention — still informative.
  assert.equal(isLossyRename('ImageJ', 'ImageJ / Fiji'), false);
});

test('computeSuggestions: suppresses lossy resourceName edit', () => {
  // identifier-scan emits curated canonical "Anti-TH"; user has more specific "Rabbit anti-TH".
  const gen = mergeDetections([
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Antibody', resourceName: 'Anti-TH', identifier: 'RRID:AB_2201407'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Antibody', resourceName: 'Rabbit anti-TH',
    identifier: 'RRID:AB_2201407', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.equal(sugs.filter(s => s.data?.column === 'resourceName').length, 0,
    'lossy resourceName edit must be suppressed');
});

test('computeSuggestions: never surfaces resourceName edits (even enriching ones)', () => {
  // Per ASAP, the tool must not suggest renaming an existing KRT row — not even
  // a more-specific curated name. resourceName is excluded from editableColumns.
  const gen = mergeDetections([
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Antibody', resourceName: 'Rabbit anti-TH (clone TH2)',
      identifier: 'RRID:AB_2201407'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Antibody', resourceName: 'Anti-TH',
    identifier: 'RRID:AB_2201407', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.equal(sugs.filter(s => s.data?.column === 'resourceName').length, 0);
});


// ───────────────────────────────────────────────────────────────────────────
// `additionalInformation` contract per ASAP:
//   - Persisted KRT cell stays blank on AI-driven inserts/edits.
//   - The detector blurb is preserved on suggestion.context for UI hover.
// ───────────────────────────────────────────────────────────────────────────

test('makeAddSuggestion: data.additionalInformation is blank; context holds the blurb', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({
      resourceName: 'Fiji', identifier: 'RRID:SCR_002285',
      additionalInformation: 'Detected near "image analysis was performed in Fiji…"'
    })] }
  ]);
  const sugs = computeSuggestions(gen, []);
  assert.equal(sugs.length, 1);
  assert.equal(sugs[0].data.additionalInformation, '',
    'persisted cell must be empty');
  assert.equal(sugs[0].context,
    'Detected near "image analysis was performed in Fiji…"',
    'detector blurb must survive on suggestion.context');
});

test('makeAddSuggestion: no detector blurb → context is null, data.AI stays blank', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({
      resourceName: 'Fiji', identifier: 'RRID:SCR_002285',
      additionalInformation: ''
    })] }
  ]);
  const sugs = computeSuggestions(gen, []);
  assert.equal(sugs[0].context, null);
  assert.equal(sugs[0].data.additionalInformation, '');
});

test('makeEditSuggestion: data.additionalInformation is blank; context held on suggestion', () => {
  // Generated proposes an IDENTIFIER edit (the user's row matches by name but
  // has no identifier yet). Verify the edit suggestion carries the detector
  // blurb as context, while the persisted-payload field stays empty.
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({
      resourceType: 'Antibody', resourceName: 'Anti-TH', source: '',
      identifier: 'RRID:AB_2201407',
      additionalInformation: 'Catalog T1299 nearby'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Antibody', resourceName: 'Anti-TH',
    identifier: '', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  const idEdit = sugs.find(s => s.data?.column === 'identifier');
  assert.ok(idEdit, 'expected an identifier edit suggestion');
  assert.equal(idEdit.data.additionalInformation, '');
  assert.equal(idEdit.context, 'Catalog T1299 nearby');
});

// ───────────────────────────────────────────────────────────────────────────
// Configurable suggestion suppression (PDF_ANALYSIS_SUPPRESS_SUGGESTIONS)
// ───────────────────────────────────────────────────────────────────────────

test('buildSuppressionFilter: unset → default suppresses resourceName edits + SOURCE overwrites', () => {
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
  const f = buildSuppressionFilter();
  assert.equal(f({ type: 'edit', data: { column: 'resourceName', oldValue: 'X' } }), true);
  assert.equal(f({ type: 'edit', data: { column: 'source', oldValue: 'https://x' } }), true); // filled → overwrite suppressed
  assert.equal(f({ type: 'edit', data: { column: 'source', oldValue: '' } }), false);          // empty → fill allowed
  assert.equal(f({ type: 'edit', data: { column: 'identifier', oldValue: '' } }), false);
  assert.equal(f({ type: 'add_row' }), false);
});

test('buildSuppressionFilter: state qualifier targets empty vs filled', () => {
  process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS = 'update:source:filled, update:identifier:empty';
  const f = buildSuppressionFilter();
  assert.equal(f({ type: 'edit', data: { column: 'source', oldValue: 'x' } }), true);     // filled → drop
  assert.equal(f({ type: 'edit', data: { column: 'source', oldValue: '' } }), false);      // empty → keep
  assert.equal(f({ type: 'edit', data: { column: 'identifier', oldValue: '' } }), true);   // empty → drop
  assert.equal(f({ type: 'edit', data: { column: 'identifier', oldValue: 'x' } }), false); // filled → keep
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
});

test('buildSuppressionFilter: none → suppresses nothing', () => {
  process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS = 'none';
  const f = buildSuppressionFilter();
  assert.equal(f({ type: 'edit', data: { column: 'resourceName' } }), false);
  assert.equal(f({ type: 'add_row' }), false);
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
});

test('buildSuppressionFilter: update:source drops SOURCE edits only', () => {
  process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS = 'update:source';
  const f = buildSuppressionFilter();
  assert.equal(f({ type: 'edit', data: { column: 'source' } }), true);
  assert.equal(f({ type: 'edit', data: { column: 'identifier' } }), false);
  assert.equal(f({ type: 'add_row' }), false);
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
});

test('buildSuppressionFilter: multiple tokens + bare actions', () => {
  process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS = 'add, edit:identifier';
  const f = buildSuppressionFilter();
  assert.equal(f({ type: 'add_row' }), true);
  assert.equal(f({ type: 'edit', data: { column: 'identifier' } }), true);
  assert.equal(f({ type: 'edit', data: { column: 'source' } }), false);
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
});

test('computeSuggestions honours PDF_ANALYSIS_SUPPRESS_SUGGESTIONS (drops SOURCE edits)', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({
      resourceType: 'Software/code', resourceName: 'Tool', source: 'https://example.org',
      identifier: 'RRID:SCR_000001'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Software/code', resourceName: 'Tool',
    identifier: 'RRID:SCR_000001', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  // Baseline: a SOURCE edit is produced (user's source is empty).
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
  assert.ok(computeSuggestions(gen, krt).some(s => s.data?.column === 'source'));
  // With the filter: the SOURCE edit is dropped.
  process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS = 'update:source';
  assert.equal(computeSuggestions(gen, krt).filter(s => s.data?.column === 'source').length, 0);
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
});

test('computeSuggestions: with none, a non-lossy resourceName edit surfaces; lossy stays suppressed', () => {
  process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS = 'none';
  // Non-lossy enrichment: user 'Anti-TH' → curated 'Rabbit anti-TH (clone TH2)' adds info.
  const genGood = mergeDetections([{ source: 'identifier_detection', items: [itemAddRow({
    resourceType: 'Antibody', resourceName: 'Rabbit anti-TH (clone TH2)', identifier: 'RRID:AB_2201407'
  })] }]);
  const krtGood = [{ id: 'r1', resourceType: 'Antibody', resourceName: 'Anti-TH',
    identifier: 'RRID:AB_2201407', newReuse: 'reuse', source: '', additionalInformation: '' }];
  assert.ok(computeSuggestions(genGood, krtGood).some(s => s.data?.column === 'resourceName'));

  // Lossy rename stays suppressed by the lossy guard even with the filter off.
  const genLossy = mergeDetections([{ source: 'identifier_detection', items: [itemAddRow({
    resourceType: 'Antibody', resourceName: 'Anti-TH', identifier: 'RRID:AB_2201407'
  })] }]);
  const krtLossy = [{ id: 'r1', resourceType: 'Antibody', resourceName: 'Rabbit anti-TH',
    identifier: 'RRID:AB_2201407', newReuse: 'reuse', source: '', additionalInformation: '' }];
  assert.equal(computeSuggestions(genLossy, krtLossy).filter(s => s.data?.column === 'resourceName').length, 0);

  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
});

test('computeSuggestions: default fills an empty SOURCE but never overwrites a filled one', () => {
  delete process.env.PDF_ANALYSIS_SUPPRESS_SUGGESTIONS;
  const gen = mergeDetections([{ source: 'a', items: [itemAddRow({
    resourceName: 'Tool', identifier: 'RRID:SCR_000001', source: 'https://detector.org'
  })] }]);
  // user SOURCE filled → no source edit (overwrite suppressed by update:source:filled)
  const krtFilled = [{ id: 'r1', resourceType: 'Software/code', resourceName: 'Tool',
    identifier: 'RRID:SCR_000001', newReuse: 'reuse', source: 'https://user.org', additionalInformation: '' }];
  assert.equal(computeSuggestions(gen, krtFilled).filter(s => s.data?.column === 'source').length, 0);
  // user SOURCE empty → source edit suggested
  const krtEmpty = [{ id: 'r1', resourceType: 'Software/code', resourceName: 'Tool',
    identifier: 'RRID:SCR_000001', newReuse: 'reuse', source: '', additionalInformation: '' }];
  assert.ok(computeSuggestions(gen, krtEmpty).some(s => s.data?.column === 'source'));
});
