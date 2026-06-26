/**
 * Tests for the pure LM-decisions → suggestions/decisions mapper (no DB, no LM).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSuggestionsFromLM } = require('./kr-comparison.service');

const authorRows = [
  { id: 'r1', resourceType: 'Antibody', resourceName: 'anti-TH', source: '', identifier: '', newReuse: 'reuse' },
  { id: 'r2', resourceType: 'Software/code', resourceName: 'Fiji', source: '', identifier: '', newReuse: 'reuse' }
];
const generatedKrt = [
  { dedupKey: 'dataset||new|name:rna-seq', resourceType: 'Dataset', resourceName: 'RNA-seq', sourceUrl: 'GEO', identifier: 'GSE1', newReuse: 'new', confidence: 0.8, detectedBy: [{ source: 'datasets_detection' }] },
  { dedupKey: 'software/code|reuse|name:fiji', resourceType: 'Software/code', resourceName: 'Fiji', sourceUrl: '', identifier: 'RRID:SCR_1', newReuse: 'reuse', confidence: 0.9, detectedBy: [{ source: 'identifier_detection' }] }
];

test('add → add_row suggestion carrying detection-module origin (mergedFrom)', () => {
  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, [
    { action: 'add', generatedRef: 0, reason: 'not present in author KRT' }
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].type, 'add_row');
  assert.equal(suggestions[0].data.resourceName, 'RNA-seq');
  // 2b: origin badges read mergedFrom[].source
  assert.equal(suggestions[0].mergedFrom[0].source, 'datasets_detection');
  assert.equal(suggestions[0].source, 'datasets_detection');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'add');
  assert.equal(decisions[0].reason, 'not present in author KRT');
  // decision now carries the full row for the modal to render
  assert.equal(decisions[0].row.resourceName, 'RNA-seq');
  assert.equal(decisions[0].row.identifier, 'GSE1');
});

test('skip → no suggestion, but a decision with reason for the summary (2c)', () => {
  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, [
    { action: 'skip', generatedRef: 1, reason: 'already in author KRT (row r2)' }
  ]);
  assert.equal(suggestions.length, 0);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'skip');
  assert.equal(decisions[0].resourceName, 'Fiji');
  assert.equal(decisions[0].reason, 'already in author KRT (row r2)');
});

test('update → edit per filled column; decision carries row + per-column diff', () => {
  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, [
    { action: 'update', authorRowId: 'r2', generatedRef: 1, changes: { identifier: 'RRID:SCR_1' }, reason: 'author row missing RRID' }
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].type, 'edit');
  assert.equal(suggestions[0].data.column, 'identifier');
  assert.equal(suggestions[0].data.newValue, 'RRID:SCR_1');
  assert.equal(suggestions[0].mergedFrom[0].source, 'identifier_detection');
  // decision diff view: the author row + old→new per changed column
  assert.equal(decisions[0].row.resourceName, 'Fiji');
  assert.deepEqual(decisions[0].changes.identifier, { old: '', new: 'RRID:SCR_1' });
});

test('reason: raw row UUIDs are stripped for display', () => {
  const { decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, [
    { action: 'skip', generatedRef: 1, reason: 'already present in the author’s KRT (row a3d12b3a-07c5-4e1c-a00a-a58ae7efcbc7). More specific entry.' }
  ]);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(decisions[0].reason), `UUID leaked: "${decisions[0].reason}"`);
  assert.ok(!/\(\s*\)/.test(decisions[0].reason), 'empty parens left behind');
});

test('update with unknown authorRowId is ignored', () => {
  const { suggestions } = buildSuggestionsFromLM(authorRows, generatedKrt, [
    { action: 'update', authorRowId: 'nope', changes: { identifier: 'X' } }
  ]);
  assert.equal(suggestions.length, 0);
});

test('remove → delete_row targeting the author row', () => {
  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, [
    { action: 'remove', authorRowId: 'r1', reason: 'duplicate of r5' }
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].type, 'delete_row');
  assert.equal(suggestions[0].data.rowId, 'r1');
  assert.equal(decisions[0].action, 'remove');
});

test('non-array → empty', () => {
  assert.deepEqual(buildSuggestionsFromLM(authorRows, generatedKrt, null), { suggestions: [], decisions: [] });
});
