/**
 * Tests for the materials pipeline steps.
 *
 * detectMaterials hits Gemini (PDF input) and is exercised via integration.
 * Here we test buildKrtItemsMaterials in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtItemsMaterials } = require('./materials.service');

test('buildKrtItemsMaterials: empty / non-array → []', () => {
  assert.deepEqual(buildKrtItemsMaterials([]), []);
  assert.deepEqual(buildKrtItemsMaterials(null), []);
  assert.deepEqual(buildKrtItemsMaterials(undefined), []);
});

test('buildKrtItemsMaterials: prompt-shape → canonical KrtEntry', () => {
  const raw = [{
    canonical_name: 'Anti-Tubulin antibody',
    resource_type: 'Antibodies',
    source: 'Sigma-Aldrich',
    identifier: 'A8592',
    newReuse: 'reuse',
    krt_relevance: 'HIGH'
  }];
  const items = buildKrtItemsMaterials(raw);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.resourceType, 'Antibodies');
  assert.equal(item.resourceName, 'Anti-Tubulin antibody');
  assert.equal(item.identifier, 'A8592');
  assert.equal(item.source, 'Sigma-Aldrich');
  assert.equal(item.newReuse, 'reuse');
  assert.equal(item.origin, 'materials-gemini');
  assert.equal(item.confidence, 0.95);
  assert.equal(item.detectorMeta.relevance, 'HIGH');
});

test('buildKrtItemsMaterials: defaults resourceType to Lab Material when missing', () => {
  const items = buildKrtItemsMaterials([{ canonical_name: 'Some reagent' }]);
  assert.equal(items[0].resourceType, 'Lab Material');
});
