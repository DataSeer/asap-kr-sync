/**
 * Integration smoke test: verify the canonical KrtEntry shape produced by the
 * identifier-detection pipeline merges cleanly with mergeDetections.
 *
 * The full processIdentifierDetection function reads from DB + S3; this test
 * doesn't exercise that I/O layer. Instead it drives the exported pipeline
 * steps (detectIdentifiers → buildKrtItemsIdentifier → dedupeKrtItems) so it
 * tests the SAME contract the worker uses, with no duplication.
 *
 * Run with: node --test services/identifier-detection/identifier-detection.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIndex } = require('./known-identifier-index.service');
const {
  detectIdentifiers,
  buildKrtItemsIdentifier
} = require('./identifier-detection.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { mergeDetections } = require('../pdf-analysis/merge-detections.service');

// Same mapping/values as identifier-detection.service.js. Test mirrors them
// so changes there are caught here, not silently divergent.
const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIJI = {
  id: 'e-fiji',
  category: 'software',
  resourceType: 'Software/code',
  resourceName: 'Fiji',
  source: 'https://fiji.sc',
  identifier: 'RRID:SCR_002285',
  newReuse: 'reuse'
};

const SIGMA_A8592 = {
  id: 'e-sigma-a8592',
  category: 'materials',
  resourceType: 'Antibodies',
  resourceName: 'Anti-Tubulin antibody',
  source: 'Sigma-Aldrich',
  identifier: 'A8592',
  newReuse: 'reuse'
};

const GEO_GSE = {
  id: 'e-geo-gse',
  category: 'datasets',
  resourceType: 'Datasets',
  resourceName: 'Cortex scRNA-seq',
  source: 'GEO',
  identifier: 'GSE165095',
  newReuse: 'reuse'
};

// Helper: full pipeline from text → final items (matches the worker's order).
function runPipeline(text, entries) {
  const index = buildIndex(entries);
  const { matches } = detectIdentifiers(text, index);
  const krt = buildKrtItemsIdentifier(matches, text);
  return dedupeKrtItems(krt, 'identifier-scan');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('buildKrtItemsIdentifier emits canonical KrtEntry fields', () => {
  const text = 'Image analysis used Fiji (RRID:SCR_002285).';
  const index = buildIndex([FIJI]);
  const { matches } = detectIdentifiers(text, index);
  const items = buildKrtItemsIdentifier(matches, text);

  assert.equal(items.length, 1);
  const item = items[0];
  // Canonical top-level fields
  assert.equal(item.resourceType, 'Software/code');
  assert.equal(item.resourceName, 'Fiji');
  assert.equal(item.identifier, 'RRID:SCR_002285');
  assert.equal(item.source, 'https://fiji.sc');
  assert.equal(item.newReuse, 'reuse');
  assert.equal(item.origin, 'identifier-scan');
  assert.equal(item.confidence, RELEVANCE_TO_CONFIDENCE.HIGH);
  // Detector-private metadata lives on detectorMeta
  assert.equal(item.detectorMeta.relevance, 'HIGH');
  assert.equal(item.detectorMeta.category, 'software');
  assert.ok(Array.isArray(item.detectorMeta.matchedTypes));
});

test('emitted items satisfy merge-detections required fields', () => {
  const text = [
    '# Methods',
    'Image analysis used Fiji (RRID:SCR_002285).',
    'Anti-Tubulin antibody (Sigma-Aldrich, Cat# A8592) at 1:1000.',
    'Raw reads were deposited to GEO under accession GSE165095.'
  ].join('\n');
  const items = runPipeline(text, [FIJI, SIGMA_A8592, GEO_GSE]);
  assert.equal(items.length, 3);

  for (const item of items) {
    assert.ok(item.resourceType, `resourceType required, got ${item.resourceType}`);
    // merge-detections drops items missing both identifier and resourceName
    assert.ok(item.identifier || item.resourceName, 'identifier or resourceName required');
  }
});

test('pipeline output merges into Generated KRT via mergeDetections', () => {
  const text = [
    'Image analysis used Fiji (RRID:SCR_002285).',
    'Anti-Tubulin antibody (Sigma-Aldrich, Cat# A8592).',
    'Reads at GSE165095.'
  ].join('\n');
  const items = runPipeline(text, [FIJI, SIGMA_A8592, GEO_GSE]);

  const merged = mergeDetections([{ source: 'identifier_detection', items }]);
  assert.equal(merged.length, 3);

  for (const row of merged) {
    assert.ok(row.detectedBy.length >= 1);
    assert.equal(row.detectedBy[0].source, 'identifier_detection');
  }

  const fiji = merged.find(r => r.resourceName === 'Fiji');
  assert.ok(fiji, 'Fiji row missing');
  assert.match(fiji.identifier, /SCR_002285/i);
  assert.equal(fiji.resourceType, 'Software/code');
});

test('identifier-scan and software_detection items dedup on shared identifier', () => {
  const text = 'Fiji (RRID:SCR_002285) was used.';
  const scannerItems = runPipeline(text, [FIJI]);

  // Softcite items always pass through enrichmentListService.enrichMentions
  // before reaching the consolidator, so newReuse gets populated from the
  // curated list. Mirror that here so the merge contract is exercised
  // realistically — empty newReuse vs populated newReuse is a known
  // non-merge condition by design. Softcite items use canonical fields once
  // the four-step refactor reaches the software detector (P6); until then
  // the merger's permissive toResource() handles both spellings.
  const softciteItems = [{
    resourceType: 'Software/code',
    resourceName: 'Fiji',
    source: 'https://fiji.sc',
    identifier: '',
    newReuse: 'reuse',
    confidence: 0.85,
    additionalInformation: 'Softcite-detected',
    origin: 'softcite-only'
  }];

  const merged = mergeDetections([
    { source: 'software_detection',     items: softciteItems },
    { source: 'identifier_detection',   items: scannerItems }
  ]);
  assert.equal(merged.length, 1, 'Fiji should collapse to one row');
  const sources = merged[0].detectedBy.map(d => d.source).sort();
  assert.deepEqual(sources, ['identifier_detection', 'software_detection']);
});

test('LOW catalog hit still produces a valid KrtEntry', () => {
  const padding = 'lorem ipsum '.repeat(40);
  const text = 'Sigma-Aldrich provided reagents. ' + padding + 'A8592 was used.';
  const items = runPipeline(text, [SIGMA_A8592]);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.detectorMeta.relevance, 'LOW');
  assert.equal(item.confidence, RELEVANCE_TO_CONFIDENCE.LOW);
  assert.ok(item.resourceType && item.resourceName);
});

test('dedupe pass: two enrichment entries with same name+type+newReuse merge', () => {
  // Two distinct entries that share resourceName + resourceType + newReuse.
  // Before the refactor, identifier-scan kept them separate (per entry.id).
  // After the shared dedupe step, they collapse into one — matching what the
  // cross-source merger would do anyway.
  const FIJI_ALT = { ...FIJI, id: 'e-fiji-alt', identifier: '10.5281/zenodo.123456' };
  const text = 'Fiji (RRID:SCR_002285) — also see 10.5281/zenodo.123456 for the build.';
  const items = runPipeline(text, [FIJI, FIJI_ALT]);
  assert.equal(items.length, 1, 'Fiji entries should collapse to one row');
  assert.ok(items[0].mergedFrom.length >= 2, 'mergedFrom records both contributors');
});
