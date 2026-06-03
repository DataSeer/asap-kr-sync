/**
 * Tests for the datasets pipeline steps.
 *
 * detectDatasets runs langextract + Gemini and is exercised via integration.
 * Here we test buildKrtItemsDatasets and enrichDatasets in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildKrtItemsDatasets,
  enrichDatasets
} = require('./datasets.service');
const { createCsvProvider } = require('../enrichment-list-providers');

test('buildKrtItemsDatasets: empty / non-array → []', () => {
  assert.deepEqual(buildKrtItemsDatasets([]), []);
  assert.deepEqual(buildKrtItemsDatasets(null), []);
});

test('buildKrtItemsDatasets: raw Gemini consolidation → canonical KrtEntry', () => {
  const raw = [{
    canonical_name: 'Cortex scRNA-seq',
    accessions: ['GSE165095', 'GSE165096'],
    dois: ['10.5281/zenodo.123'],
    urls: [],
    repository: 'GEO',
    dataset_role: 'REUSED',
    krt_relevance: 'HIGH',
    resource_type: 'Microarray'   // ← subtype emitted by the prompt
  }];
  const items = buildKrtItemsDatasets(raw);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.resourceType, 'Dataset');
  assert.equal(item.resourceName, 'Cortex scRNA-seq');
  assert.equal(item.source, 'GEO');
  // accessions + dois joined with '; '
  assert.match(item.identifier, /GSE165095/);
  assert.match(item.identifier, /GSE165096/);
  assert.match(item.identifier, /10\.5281\/zenodo\.123/);
  assert.equal(item.newReuse, 'reuse'); // REUSED → reuse
  assert.equal(item.origin, 'datasets-gemini');
  assert.equal(item.confidence, 0.95);
  // Per ASAP request: ADDITIONAL INFORMATION stays blank on the merged
  // item; the subtype hint lives on detectorMeta for the internal panel.
  assert.equal(item.additionalInformation, '');
  assert.equal(item.detectorMeta.relevance, 'HIGH');
  assert.equal(item.detectorMeta.subtype, 'Microarray');
});

test('buildKrtItemsDatasets: items without canonical_name are dropped', () => {
  const items = buildKrtItemsDatasets([
    { canonical_name: 'Real', accessions: ['GSE1'] },
    { canonical_name: '',     accessions: ['GSE2'] },
    { /* no name at all */    accessions: ['GSE3'] }
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].resourceName, 'Real');
});

test('buildKrtItemsDatasets: dataset_role GENERATED → newReuse=new', () => {
  const items = buildKrtItemsDatasets([{
    canonical_name: 'New data', dataset_role: 'GENERATED', accessions: ['x']
  }]);
  assert.equal(items[0].newReuse, 'new');
});

test('buildKrtItemsDatasets: legacy demo shape (resource_type=Dataset, joined identifier) round-trips', () => {
  // The demo files store items post-transform. Make sure passing them back
  // through buildKrtItemsDatasets produces the same canonical KrtEntry.
  const legacy = [{
    canonical_name: 'Legacy dataset',
    resource_type: 'Dataset',
    source: 'GEO',
    identifier: 'GSE999',
    newReuse: 'reuse',
    krt_relevance: 'HIGH'
  }];
  const items = buildKrtItemsDatasets(legacy);
  assert.equal(items.length, 1);
  assert.equal(items[0].resourceType, 'Dataset');
  assert.equal(items[0].identifier, 'GSE999');
  assert.equal(items[0].newReuse, 'reuse');
});

test('enrichDatasets: fills blanks from CSV provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-enrich-'));
  fs.writeFileSync(path.join(dir, 'curated-datasets.csv'),
    'resourceName,resourceType,source,identifier,newReuse\n' +
    'Cortex scRNA-seq,Dataset,GEO,GSE165095,reuse\n'
  );
  const provider = createCsvProvider(dir);

  const items = buildKrtItemsDatasets([{
    canonical_name: 'Cortex scRNA-seq', accessions: ['GSE165095'], dataset_role: 'REUSED'
  }]);
  // Pre-enrich: source filled from `repository` (absent here, so empty)
  assert.equal(items[0].source, '');
  const { enriched } = await enrichDatasets(items, { provider });
  // Post-enrich: source filled from curated list
  assert.equal(enriched[0].source, 'GEO');
  assert.equal(enriched[0].detectorMeta.enrichmentMeta.matched, true);

  fs.rmSync(dir, { recursive: true, force: true });
});
