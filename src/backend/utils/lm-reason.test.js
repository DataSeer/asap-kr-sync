/**
 * The reason-scrubbing rules, pinned on the backend side.
 *
 * These cases are deliberately the same ones the frontend's copy is tested
 * against (src/frontend/src/components/modules/generated-krt.test.js). The two
 * implementations cannot share code across the runtime boundary, so they share
 * a test corpus instead: if one drifts, its own suite fails.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanReason } = require('./lm-reason');

test('strips the candidate refs the curator has no name for', () => {
  assert.equal(cleanReason('merged duplicates (refs 0 and 4)'), 'merged duplicates');
  assert.equal(cleanReason('kept ref 7'), 'kept');
  assert.equal(cleanReason('merged refs 1, 2 & 3 into one row'), 'merged into one row');
});

test('replaces a row UUID used as an object with words', () => {
  const uuid = 'a3d12f45-1234-4321-8888-abcdefabcdef';
  assert.equal(cleanReason(`matched row ${uuid}`), 'matched the matching author row');
});

test('drops a parenthesised row id outright — the row is already on screen', () => {
  const uuid = 'a3d12f45-1234-4321-8888-abcdefabcdef';
  assert.equal(cleanReason(`kept (row ${uuid})`), 'kept');
  assert.equal(cleanReason(`kept (${uuid})`), 'kept');
});

test('handles BOTH kinds in one reason — the case each half used to miss', () => {
  // krt-generation stripped refs only, kr-comparison UUIDs only. A reason
  // carrying both left one of them in whichever service produced it.
  const uuid = 'a3d12f45-1234-4321-8888-abcdefabcdef';
  const out = cleanReason(`merged refs 0 and 4 into row ${uuid}`);
  assert.ok(!out.includes('ref'), out);
  assert.ok(!out.includes(uuid), out);
});

test('leaves an ordinary reason alone', () => {
  assert.equal(cleanReason('Named in the methods section'), 'Named in the methods section');
  assert.equal(cleanReason('Reference 12 of the bibliography'), 'Reference 12 of the bibliography');
});

test('returns an empty string for nothing, never undefined', () => {
  assert.equal(cleanReason(null), '');
  assert.equal(cleanReason(undefined), '');
  assert.equal(cleanReason(''), '');
});
