/**
 * Tests for the materials pipeline steps.
 *
 * detectMaterials hits Gemini (PDF input) and is exercised via integration.
 * Here we test buildKrtItemsMaterials and enrichMaterials in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildKrtItemsMaterials,
  enrichMaterials
} = require('./materials.service');
const { createCsvProvider } = require('../enrichment-list-providers');

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

test('enrichMaterials: fills blanks from CSV provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-enrich-'));
  fs.writeFileSync(path.join(dir, 'curated-materials.csv'),
    'resourceName,resourceType,source,identifier,newReuse\n' +
    'Anti-Tubulin antibody,Antibodies,Sigma-Aldrich,A8592,reuse\n'
  );
  const provider = createCsvProvider(dir);

  const items = buildKrtItemsMaterials([{ canonical_name: 'Anti-Tubulin antibody' }]);
  const { enriched } = await enrichMaterials(items, { provider });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].source, 'Sigma-Aldrich');
  assert.equal(enriched[0].identifier, 'A8592');
  assert.equal(enriched[0].newReuse, 'reuse');
  assert.equal(enriched[0].detectorMeta.enrichmentMeta.matched, true);

  fs.rmSync(dir, { recursive: true, force: true });
});
