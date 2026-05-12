/**
 * Tests for the suggestion diff service.
 * Run with: node --test src/backend/services/pdf-analysis/diff-suggestions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { mergeDetections } = require('./merge-detections.service');
const { computeSuggestions, parseSuggestionId } = require('./diff-suggestions.service');

const itemAddRow = (overrides = {}) => ({
  type: 'add_row',
  data: {
    resourceType: 'Code/Software',
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
    resourceType: 'Code/Software', resourceName: 'Python', source: 'https://python.org',
    identifier: '10.1234/x', newReuse: 'reuse', additionalInformation: ''
  }];
  assert.deepEqual(computeSuggestions(gen, krt), []);
});

test('Same dedup_key + different additional info → edit suggestion', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x', additionalInformation: 'v3.10' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Code/Software', resourceName: 'Python', source: 'https://python.org',
    identifier: '10.1234/x', newReuse: 'reuse', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.equal(sugs.length, 1);
  assert.equal(sugs[0].type, 'edit');
  assert.equal(sugs[0].data.column, 'additionalInformation');
  assert.equal(sugs[0].matchedKrtRowId, 'r1');
});

test('Rejected add → suggestion suppressed', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'New Tool', identifier: 'id-1' })] }
  ]);
  const dk = gen[0].dedupKey;
  assert.deepEqual(computeSuggestions(gen, [], new Set([dk])), []);
});

test('Rejected column → that column suppressed, others kept', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x', additionalInformation: 'v3.10', source: 'https://other.org' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Code/Software', resourceName: 'Python', source: 'https://python.org',
    identifier: '10.1234/x', newReuse: 'reuse', additionalInformation: ''
  }];
  const dk = gen[0].dedupKey;
  const rejCols = new Map([[dk, new Set(['source'])]]);
  const sugs = computeSuggestions(gen, krt, new Set(), rejCols);
  assert.equal(sugs.length, 1);
  assert.equal(sugs[0].data.column, 'additionalInformation');
});

test('Generator value is empty → no edit suggested (does not blank user data)', () => {
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: '10.1234/x', additionalInformation: '' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Code/Software', resourceName: 'Python', source: 'https://python.org',
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
    id: 'r1', resourceType: 'Code/Software', resourceName: 'ImageJ',
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
  assert.ok(sugs.every(s => s.type === 'edit'));
  assert.ok(sugs.some(s => s.data.column === 'resourceName'));
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
      resourceType: 'Code/Software', resourceName: 'Python', identifier: 'id-x'
    })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Dataset', resourceName: 'Python',
    identifier: 'id-x', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.ok(sugs.some(s => s.type === 'add_row'));
});

test('alias matcher refuses different newReuse', () => {
  // Same identifier + name but newReuse mismatch → not a match.
  const gen = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Tool', identifier: 'id-1', newReuse: 'new' })] }
  ]);
  const krt = [{
    id: 'r1', resourceType: 'Code/Software', resourceName: 'Tool',
    identifier: 'id-1', newReuse: 'reuse', source: '', additionalInformation: ''
  }];
  const sugs = computeSuggestions(gen, krt);
  assert.ok(sugs.some(s => s.type === 'add_row'));
});
