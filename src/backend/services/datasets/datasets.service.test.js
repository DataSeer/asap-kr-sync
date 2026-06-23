/**
 * Tests for the datasets pipeline steps.
 *
 * detectDatasets runs langextract + Gemini and is exercised via integration.
 * Here we test buildKrtItemsDatasets in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtItemsDatasets, buildAuthorDatasetSeeds, splitKrtIdentifiers } = require('./datasets.service');

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

// ── Author KRT seeding (v3) ───────────────────────────────────────────────

test('splitKrtIdentifiers: classifies accessions, DOIs, URLs', () => {
  const out = splitKrtIdentifiers('GSE236732; https://zenodo.org/records/1 10.5281/zenodo.20213678 doi:10.1/abc');
  assert.deepEqual(out.accessions, ['GSE236732']);
  assert.deepEqual(out.urls, ['https://zenodo.org/records/1']);
  assert.deepEqual(out.dois, ['10.5281/zenodo.20213678', '10.1/abc']);
});

test('splitKrtIdentifiers: bare prefix without a digit is not an accession; empty → empty', () => {
  assert.deepEqual(splitKrtIdentifiers('PDB EGA'), { accessions: [], dois: [], urls: [] });
  assert.deepEqual(splitKrtIdentifiers(''), { accessions: [], dois: [], urls: [] });
  assert.deepEqual(splitKrtIdentifiers(null), { accessions: [], dois: [], urls: [] });
});

test('buildAuthorDatasetSeeds: maps KRT rows; reuse→REUSED; harvests URL from additional info; drops nameless', () => {
  const seeds = buildAuthorDatasetSeeds([
    { resourceName: 'RNAseq', source: 'GEO', identifier: 'GSE236732', newReuse: 'new', additionalInformation: 'raw reads' },
    { resourceName: 'hg19', source: 'UCSC', identifier: '', newReuse: 'reuse', additionalInformation: 'see https://genome.ucsc.edu' },
    { resourceName: '', source: 'x', identifier: 'y', newReuse: 'new', additionalInformation: '' }
  ]);
  assert.equal(seeds.length, 2);
  assert.deepEqual(seeds[0], {
    name: 'RNAseq', role: 'GENERATED', source: 'GEO',
    accessions: ['GSE236732'], dois: [], urls: [], additional_info: 'raw reads'
  });
  assert.equal(seeds[1].role, 'REUSED');
  assert.deepEqual(seeds[1].urls, ['https://genome.ucsc.edu']);
});

test('buildAuthorDatasetSeeds: empty / non-array → []', () => {
  assert.deepEqual(buildAuthorDatasetSeeds([]), []);
  assert.deepEqual(buildAuthorDatasetSeeds(null), []);
});
