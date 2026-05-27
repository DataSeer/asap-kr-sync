/**
 * Tests for dedupeKrtItems — in-detector dedup pure function.
 *
 * Covers the cases each detector will exercise:
 *   - empty / single-item inputs (no-op)
 *   - merge by identifier-token intersection
 *   - merge by name match
 *   - non-merge when resourceType differs
 *   - non-merge when newReuse differs
 *   - mergedFrom carries all contributors
 *   - representative fields come from the highest-confidence contributor
 *   - detectorMeta is preserved from the strongest contributor
 *   - transitive (3-way chain) merging
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dedupeKrtItems } = require('./dedupe-krt-items.service');

const krtItem = (overrides = {}) => ({
  resourceType: 'Software/code',
  resourceName: 'Python',
  identifier: '',
  source: '',
  newReuse: 'reuse',
  origin: 'test-detector',
  confidence: 0.8,
  additionalInformation: '',
  ...overrides
});

test('empty input → empty output', () => {
  assert.deepEqual(dedupeKrtItems([]), []);
  assert.deepEqual(dedupeKrtItems(null), []);
  assert.deepEqual(dedupeKrtItems(undefined), []);
});

test('single item → unchanged, mergedFrom has one entry', () => {
  const r = dedupeKrtItems([krtItem({ resourceName: 'Python', identifier: 'py' })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Python');
  assert.equal(r[0].identifier, 'py');
  assert.equal(r[0].mergedFrom.length, 1);
});

test('two items same identifier → merged', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'Python', identifier: 'py-id', confidence: 0.6 }),
    krtItem({ resourceName: 'python', identifier: 'py-id', confidence: 0.9 })
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].mergedFrom.length, 2);
  // Highest confidence wins for representative fields
  assert.equal(r[0].confidence, 0.9);
});

test('two items same normalized name → merged', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'GraphPad Prism', identifier: '', confidence: 0.7 }),
    krtItem({ resourceName: 'graphpad prism', identifier: '', confidence: 0.5 })
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].mergedFrom.length, 2);
});

test('different resourceType → NOT merged', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceType: 'Software/code', resourceName: 'X', identifier: 'shared-id' }),
    krtItem({ resourceType: 'Dataset',       resourceName: 'X', identifier: 'shared-id' })
  ]);
  assert.equal(r.length, 2);
});

test('different newReuse → NOT merged', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'X', identifier: 'shared-id', newReuse: 'new' }),
    krtItem({ resourceName: 'X', identifier: 'shared-id', newReuse: 'reuse' })
  ]);
  assert.equal(r.length, 2);
});

test('representative fields come from highest-confidence contributor', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'low-conf-name',  identifier: 'shared', source: 'low-src',  confidence: 0.3 }),
    krtItem({ resourceName: 'high-conf-name', identifier: 'shared', source: 'high-src', confidence: 0.9 })
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'high-conf-name');
  assert.equal(r[0].source, 'high-src');
  assert.equal(r[0].confidence, 0.9);
});

test('blanks on high-conf are filled from low-conf', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'Python', identifier: 'py-id', source: 'low-src',  confidence: 0.3 }),
    krtItem({ resourceName: 'Python', identifier: '',      source: '',         confidence: 0.9 })
  ]);
  assert.equal(r.length, 1);
  // High-conf has no source/identifier — fall back to low-conf's
  assert.equal(r[0].source, 'low-src');
  assert.equal(r[0].identifier, 'py-id');
});

test('additionalInformation is concatenated', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'X', identifier: 'id', additionalInformation: 'first ctx' }),
    krtItem({ resourceName: 'X', identifier: 'id', additionalInformation: 'second ctx' })
  ]);
  assert.equal(r.length, 1);
  assert.match(r[0].additionalInformation, /first ctx/);
  assert.match(r[0].additionalInformation, /second ctx/);
});

test('detectorMeta is preserved from the strongest contributor', () => {
  const r = dedupeKrtItems([
    krtItem({
      resourceName: 'X', identifier: 'id', confidence: 0.4,
      detectorMeta: { relevance: 'LOW', position: 100 }
    }),
    krtItem({
      resourceName: 'X', identifier: 'id', confidence: 0.9,
      detectorMeta: { relevance: 'HIGH', position: 50 }
    })
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].detectorMeta.relevance, 'HIGH');
  assert.equal(r[0].detectorMeta.position, 50);
});

test('weaker contributors are kept in mergedFrom with their detectorMeta', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'X', identifier: 'id', confidence: 0.4, detectorMeta: { position: 100 } }),
    krtItem({ resourceName: 'X', identifier: 'id', confidence: 0.9, detectorMeta: { position: 50  } })
  ]);
  assert.equal(r[0].mergedFrom.length, 2);
  const positions = r[0].mergedFrom
    .map(c => c.originalItem.detectorMeta?.position)
    .sort((a, b) => a - b);
  assert.deepEqual(positions, [50, 100]);
});

test('transitive merge: A↔B by name, B↔C by id → all three merge', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'Tool', identifier: 'id-1' }),  // A
    krtItem({ resourceName: 'tool', identifier: 'id-2' }),  // B — matches A by name, brings id-2
    krtItem({ resourceName: 'Different name', identifier: 'id-2' }) // C — matches B by id
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].mergedFrom.length, 3);
});

test('origin defaults to sourceLabel arg when originalItem has none', () => {
  const r = dedupeKrtItems([{ resourceType: 'X', resourceName: 'Y', identifier: '', newReuse: '' }], 'my-label');
  assert.equal(r[0].origin, 'my-label');
});

test('origin uses the strongest contributor\'s origin when set', () => {
  const r = dedupeKrtItems([
    krtItem({ resourceName: 'X', identifier: 'id', confidence: 0.3, origin: 'detector-a' }),
    krtItem({ resourceName: 'X', identifier: 'id', confidence: 0.9, origin: 'detector-b' })
  ]);
  assert.equal(r[0].origin, 'detector-b');
});
