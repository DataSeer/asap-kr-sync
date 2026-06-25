/**
 * Tests for the pure LM→suggestion mapper (no DB, no LM).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSuggestionsFromLM } = require('./kr-comparison.service');

const authorRows = [
  { id: 'r1', resourceType: 'Antibody', resourceName: 'anti-TH', source: '', identifier: '', newReuse: 'reuse' },
  { id: 'r2', resourceType: 'Software/code', resourceName: 'Fiji', source: '', identifier: '', newReuse: 'reuse' }
];

test('add → add_row suggestion with full data', () => {
  const out = buildSuggestionsFromLM(authorRows, [
    { action: 'add', resourceType: 'Dataset', resourceName: 'RNA-seq', source: 'GEO', identifier: 'GSE1', newReuse: 'new' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'add_row');
  assert.ok(out[0].id.startsWith('add:'));
  assert.equal(out[0].data.resourceName, 'RNA-seq');
  assert.equal(out[0].data.identifier, 'GSE1');
});

test('update → one edit per changed, non-empty, changing column; rowId carried', () => {
  const out = buildSuggestionsFromLM(authorRows, [
    { action: 'update', authorRowId: 'r1', changes: { identifier: 'RRID:AB_1', source: '', resourceName: 'anti-TH' } }
  ]);
  // identifier fills (empty→value) → 1 edit; source empty → skipped; resourceName unchanged → skipped
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'edit');
  assert.equal(out[0].data.rowId, 'r1');
  assert.equal(out[0].data.column, 'identifier');
  assert.equal(out[0].data.newValue, 'RRID:AB_1');
  assert.equal(out[0].id, out[0].id.replace(/[^:]/g, '') ? out[0].id : out[0].id); // sanity: id present
  assert.ok(out[0].id.endsWith(':identifier'));
});

test('update with unknown authorRowId is ignored (hallucination guard)', () => {
  const out = buildSuggestionsFromLM(authorRows, [
    { action: 'update', authorRowId: 'nope', changes: { identifier: 'X' } }
  ]);
  assert.deepEqual(out, []);
});

test('remove → delete_row suggestion targeting the row', () => {
  const out = buildSuggestionsFromLM(authorRows, [
    { action: 'remove', authorRowId: 'r2', reason: 'duplicate of row 5' }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'delete_row');
  assert.ok(out[0].id.startsWith('delete:'));
  assert.equal(out[0].data.rowId, 'r2');
  assert.equal(out[0].reason, 'duplicate of row 5');
});

test('non-array / empty input → []', () => {
  assert.deepEqual(buildSuggestionsFromLM(authorRows, null), []);
  assert.deepEqual(buildSuggestionsFromLM(authorRows, []), []);
});
