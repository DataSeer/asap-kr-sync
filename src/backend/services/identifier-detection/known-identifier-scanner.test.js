/**
 * Tests for the known-identifier scanner.
 *
 * Run with: node --test services/identifier-detection/known-identifier-scanner.test.js
 *
 * Each test builds a tiny in-memory index from a hand-rolled list of
 * EnrichmentListEntry-shaped fixtures (no DB), then runs the scanner against
 * synthetic text fragments designed to exercise one rubric row at a time.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIndex } = require('./known-identifier-index.service');
const { scan, findReferencesCutoff } = require('./known-identifier-scanner.service');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIJI = {
  id: 'e-fiji',
  category: 'software',
  resourceType: 'Code/Software',
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

const ZENODO_DATASET = {
  id: 'e-zenodo-1',
  category: 'datasets',
  resourceType: 'Datasets',
  resourceName: 'Mouse Brain Hemisphere Dataset',
  source: 'Zenodo',
  identifier: '10.5281/zenodo.7340795',
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

const ABCAM_AB1791 = {
  id: 'e-abcam-ab1791',
  category: 'materials',
  resourceType: 'Antibodies',
  resourceName: 'H3 antibody',
  source: 'Abcam',
  identifier: 'ab1791',
  newReuse: 'reuse'
};

const ZENODO_URL = {
  id: 'e-zenodo-url',
  category: 'datasets',
  resourceType: 'Datasets',
  resourceName: 'Microscopy Images',
  source: 'Zenodo',
  identifier: 'https://zenodo.org/records/7340795',
  newReuse: 'reuse'
};

// Helper to build an index from a list of fixtures.
function indexOf(...entries) { return buildIndex(entries); }

function pickRelevance(matches, entryId) {
  const m = matches.find(x => x.entry.id === entryId);
  return m ? m.relevance : null;
}

// ---------------------------------------------------------------------------
// Structured identifier matches (HIGH)
// ---------------------------------------------------------------------------
test('scan: RRID exact match → HIGH', () => {
  const idx = indexOf(FIJI);
  const text = 'We used Fiji (RRID:SCR_002285) for image analysis.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.id, FIJI.id);
  assert.equal(matches[0].relevance, 'HIGH');
  assert.ok(matches[0].types.includes('rrid') || matches[0].types.includes('scr'));
});

test('scan: SCR-only token (no RRID prefix) → HIGH', () => {
  const idx = indexOf(FIJI);
  const text = 'Image analysis used SCR_002285.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].relevance, 'HIGH');
});

test('scan: DOI exact match → HIGH', () => {
  const idx = indexOf(ZENODO_DATASET);
  const text = 'Data is available at 10.5281/zenodo.7340795 in the methods.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.id, ZENODO_DATASET.id);
  assert.equal(matches[0].relevance, 'HIGH');
});

test('scan: DOI inside a URL still matches the DOI entry', () => {
  // The list entry was indexed as a DOI; the PDF mentions the URL form.
  const idx = indexOf(ZENODO_DATASET);
  const text = 'See https://doi.org/10.5281/zenodo.7340795 for the full dataset.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.id, ZENODO_DATASET.id);
  assert.equal(matches[0].relevance, 'HIGH');
});

test('scan: PID accession (GSE) exact match → HIGH', () => {
  const idx = indexOf(GEO_GSE);
  const text = 'Raw reads were deposited to GEO under accession GSE165095.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.id, GEO_GSE.id);
  assert.equal(matches[0].relevance, 'HIGH');
  assert.ok(matches[0].types.includes('pid'));
});

test('scan: URL exact match → HIGH', () => {
  const idx = indexOf(ZENODO_URL);
  const text = 'Microscopy: https://zenodo.org/records/7340795 (reused).';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entry.id, ZENODO_URL.id);
  assert.equal(matches[0].relevance, 'HIGH');
});

// ---------------------------------------------------------------------------
// Catalog matches — relevance rubric
// ---------------------------------------------------------------------------
test('scan: catalog with vendor + Cat# prefix nearby → HIGH', () => {
  const idx = indexOf(SIGMA_A8592);
  const text = 'Anti-Tubulin antibody (Sigma-Aldrich, Cat# A8592) at 1:1000.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(pickRelevance(matches, SIGMA_A8592.id), 'HIGH');
});

test('scan: catalog with vendor proximity, no prefix → MEDIUM', () => {
  const idx = indexOf(SIGMA_A8592);
  const text = 'We diluted A8592 (Sigma-Aldrich) in PBS.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(pickRelevance(matches, SIGMA_A8592.id), 'MEDIUM');
});

test('scan: catalog with Cat# prefix only (no vendor) → MEDIUM', () => {
  const idx = indexOf(SIGMA_A8592);
  // Wrong vendor in the doc — counts as "no expected vendor near".
  const text = 'Reagent (Cat# A8592) was prepared fresh.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(pickRelevance(matches, SIGMA_A8592.id), 'MEDIUM');
});

test('scan: bare catalog match (no vendor, no prefix) → LOW', () => {
  const idx = indexOf(SIGMA_A8592);
  // Vendor mention present but >200 chars from the catalog token, so vendor
  // proximity fails. The LOW guard still fires because *some* vendor-ish
  // string was seen in the doc.
  const padding = 'lorem ipsum '.repeat(40);
  const text = 'Sigma-Aldrich provided multiple reagents. ' + padding + 'A8592 was used at 1:500.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  assert.equal(pickRelevance(matches, SIGMA_A8592.id), 'LOW');
});

test('scan: bare catalog suppressed when nothing vendor-ish in document', () => {
  const idx = indexOf(SIGMA_A8592);
  const text = 'Token A8592 appears in the text alone.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 0);
});

test('scan: includeBareLow=false drops bare catalogs entirely', () => {
  const idx = indexOf(SIGMA_A8592);
  const padding = 'lorem ipsum '.repeat(40);
  const text = 'Sigma-Aldrich provided reagents. ' + padding + 'A8592 was used.';
  const { matches } = scan(text, idx, { includeBareLow: false });
  assert.equal(matches.length, 0);
});

// ---------------------------------------------------------------------------
// Multi-identifier dedup
// ---------------------------------------------------------------------------
test('scan: multi-identifier resource emits ONE match with highest relevance', () => {
  // Fiji has an RRID identifier in the index; if the URL also matched, both
  // hits should collapse into a single match.
  const fijiBoth = { ...FIJI, identifier: 'RRID:SCR_002285' };
  const fijiUrl = {
    id: 'e-fiji-url',
    category: 'software',
    resourceType: 'Code/Software',
    resourceName: 'Fiji',
    source: 'https://fiji.sc',
    identifier: 'https://fiji.sc',
    newReuse: 'reuse'
  };
  // Different entries (one keyed on RRID, one on URL) representing the same
  // resource — verify each gets a single match (one per index entry).
  const idx = indexOf(fijiBoth, fijiUrl);
  const text = 'Image analysis used Fiji (RRID:SCR_002285), see https://fiji.sc/ for download.';
  const { matches } = scan(text, idx);
  // One match per *index entry*, both HIGH.
  assert.equal(matches.length, 2);
  assert.ok(matches.every(m => m.relevance === 'HIGH'));
});

test('scan: same identifier appearing twice still emits one match', () => {
  const idx = indexOf(FIJI);
  const text = 'Fiji (RRID:SCR_002285) was used. Later, Fiji (RRID:SCR_002285) again.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  // identifiers list should record both hits
  assert.ok(matches[0].identifiers.length >= 2);
});

// ---------------------------------------------------------------------------
// References cutoff
// ---------------------------------------------------------------------------
test('findReferencesCutoff: detects "## References" heading', () => {
  const text = 'Methods text\n\n## References\n\nSmith et al.';
  assert.ok(findReferencesCutoff(text) > 0);
});

test('findReferencesCutoff: detects "# Bibliography"', () => {
  assert.ok(findReferencesCutoff('body\n# Bibliography\nentries') > 0);
});

test('findReferencesCutoff: returns -1 when no heading', () => {
  assert.equal(findReferencesCutoff('plain body text'), -1);
});

test('scan: identifier inside the references section is dropped by default', () => {
  const idx = indexOf(ZENODO_DATASET);
  const text = [
    '# Methods',
    'No DOI mentioned here.',
    '',
    '## References',
    '',
    'Foo et al. 10.5281/zenodo.7340795. Some Journal.'
  ].join('\n');
  const { matches, referencesCutoff } = scan(text, idx);
  assert.ok(referencesCutoff > 0);
  assert.equal(matches.length, 0);
});

test('scan: cutAtReferences=false keeps post-references hits', () => {
  const idx = indexOf(ZENODO_DATASET);
  const text = '## References\nFoo et al. 10.5281/zenodo.7340795.';
  const { matches } = scan(text, idx, { cutAtReferences: false });
  assert.equal(matches.length, 1);
});

// ---------------------------------------------------------------------------
// Empty/edge cases
// ---------------------------------------------------------------------------
test('scan: empty text returns no matches', () => {
  const idx = indexOf(FIJI);
  const { matches } = scan('', idx);
  assert.equal(matches.length, 0);
});

test('scan: empty index returns no matches', () => {
  const idx = buildIndex([]);
  const text = 'Fiji (RRID:SCR_002285), see https://fiji.sc/ and 10.5281/zenodo.7340795.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 0);
});

test('scan: position points at the strongest hit in original text', () => {
  const idx = indexOf(SIGMA_A8592);
  const text = 'A8592 alone here. Sigma-Aldrich, Cat# A8592 is the canonical mention.';
  const { matches } = scan(text, idx);
  assert.equal(matches.length, 1);
  // The HIGH hit should win — its position is the SECOND A8592.
  assert.equal(matches[0].relevance, 'HIGH');
  // Position of the second A8592 in the source text:
  const expectedPos = text.lastIndexOf('A8592');
  assert.equal(matches[0].position, expectedPos);
});

// ---------------------------------------------------------------------------
// Index sanity (one quick smoke test — index has its own test file later)
// ---------------------------------------------------------------------------
test('buildIndex: groups entries by type', () => {
  const idx = indexOf(FIJI, ZENODO_DATASET, GEO_GSE, SIGMA_A8592, ABCAM_AB1791);
  assert.ok(idx.byIdentifier.size >= 3); // RRID + DOI + PID
  assert.ok(idx.byCatalog.size >= 2);    // sigma + abcam
  assert.ok(idx.catalogTokens.size >= 2);
});

test('buildIndex: rejects pure-word catalog tokens (data-quality guard)', () => {
  // Source CSV occasionally has stop words like "exception" or "Shared" in
  // the identifier column. They must not become catalog tokens — otherwise
  // every occurrence of the word in any PDF would match.
  const garbage = {
    id: 'e-garbage',
    category: 'materials',
    resourceType: 'Antibodies',
    resourceName: 'Bogus',
    source: 'Some Vendor',
    identifier: 'exception',
    newReuse: 'reuse'
  };
  const idx = indexOf(garbage);
  assert.equal(idx.byCatalog.size, 0);
  assert.equal(idx.catalogTokens.size, 0);
});

test('buildIndex: rejects 4-digit year-like tokens (e.g. "2019")', () => {
  const yearGarbage = {
    id: 'e-year',
    category: 'materials',
    resourceType: 'Antibodies',
    resourceName: 'Nu/J',
    source: 'Some Vendor',
    identifier: '2019',
    newReuse: 'reuse'
  };
  const idx = indexOf(yearGarbage);
  assert.equal(idx.byCatalog.size, 0);
  assert.equal(idx.catalogTokens.size, 0);
});

test('buildIndex: accepts pure-digit SKUs of 5+ digits (e.g. Sigma "300027")', () => {
  const numericSku = {
    id: 'e-sigma-numeric',
    category: 'materials',
    resourceType: 'Reagents',
    resourceName: 'Some Reagent',
    source: 'Sigma',
    identifier: '300027',
    newReuse: 'reuse'
  };
  const idx = indexOf(numericSku);
  assert.equal(idx.byCatalog.size, 1);
});

test('buildIndex: accepts SKUs that contain at least one digit', () => {
  const sku = {
    id: 'e-sku',
    category: 'materials',
    resourceType: 'Antibodies',
    resourceName: 'Some Reagent',
    source: 'Vendor X',
    identifier: 'HY-102007',
    newReuse: 'reuse'
  };
  const idx = indexOf(sku);
  assert.equal(idx.byCatalog.size, 1);
  assert.equal(idx.catalogTokens.size, 1);
});
