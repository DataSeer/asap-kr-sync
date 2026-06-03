/**
 * Tests for the software pipeline steps.
 *
 * detectSoftware hits the Softcite API and is exercised via integration.
 * Here we test buildKrtItemsSoftware and enrichSoftware in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildKrtItemsSoftware,
  enrichSoftware
} = require('./software.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { createCsvProvider } = require('../enrichment-list-providers');

test('buildKrtItemsSoftware: empty / non-array → []', () => {
  assert.deepEqual(buildKrtItemsSoftware([]), []);
  assert.deepEqual(buildKrtItemsSoftware(null), []);
});

test('buildKrtItemsSoftware: Softcite-shape → canonical KrtEntry', () => {
  const raw = [{
    name: 'MATLAB R2019b',
    normalizedName: 'MATLAB',
    url: 'https://mathworks.com',
    version: 'R2019b',
    creator: 'MathWorks',
    confidence: 0.9,
    context: 'Statistics computed in MATLAB R2019b.'
  }];
  const items = buildKrtItemsSoftware(raw);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.resourceType, 'Software/code');
  // Normalized name wins for the canonical resourceName
  assert.equal(item.resourceName, 'MATLAB');
  assert.equal(item.source, 'https://mathworks.com');
  assert.equal(item.confidence, 0.9);
  assert.equal(item.origin, 'softcite');
  // Per ASAP request: do NOT push the detector context blurb into the
  // user-facing ADDITIONAL INFORMATION cell. It lives on detectorMeta
  // (both `context` for the panel and `additionalInformation` for
  // downstream enrichment) instead.
  assert.equal(item.additionalInformation, '');
  // Softcite-specific fields go to detectorMeta
  assert.equal(item.detectorMeta.softciteName, 'MATLAB R2019b');
  assert.equal(item.detectorMeta.normalizedName, 'MATLAB');
  assert.equal(item.detectorMeta.version, 'R2019b');
  assert.equal(item.detectorMeta.context, 'Statistics computed in MATLAB R2019b.');
});

test('buildKrtItemsSoftware: missing confidence → default', () => {
  const items = buildKrtItemsSoftware([{ name: 'Python' }]);
  assert.equal(items[0].confidence, 0.7);
});

test('buildKrtItemsSoftware: falls back to `name` when normalizedName is missing', () => {
  const items = buildKrtItemsSoftware([{ name: 'GraphPad Prism' }]);
  assert.equal(items[0].resourceName, 'GraphPad Prism');
});

test('enrichSoftware: customListMatch fills blanks and moves to detectorMeta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-enrich-'));
  fs.writeFileSync(path.join(dir, 'curated-software.csv'),
    'resourceName,resourceType,source,identifier,newReuse\n' +
    'MATLAB,Software/code,https://mathworks.com/matlab,RRID:SCR_001622,reuse\n'
  );
  const provider = createCsvProvider(dir);

  const items = buildKrtItemsSoftware([{
    name: 'MATLAB R2019b', normalizedName: 'MATLAB', url: '', confidence: 0.9
  }]);
  const { enriched } = await enrichSoftware(items, { provider });

  assert.equal(enriched.length, 1);
  // Blanks filled from curated list
  assert.equal(enriched[0].source, 'https://mathworks.com/matlab');
  assert.equal(enriched[0].identifier, 'RRID:SCR_001622');
  assert.equal(enriched[0].newReuse, 'reuse');
  // Provenance lives under detectorMeta
  assert.equal(enriched[0].detectorMeta.enrichmentMeta.matched, true);
  assert.ok(enriched[0].detectorMeta.customListMatch);
  // No customListMatch / enrichmentMeta at the top level
  assert.equal(enriched[0].customListMatch, undefined);
  assert.equal(enriched[0].enrichmentMeta, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('full pipeline: two Softcite mentions of MATLAB → 1 item with occurrences=2 in mergedFrom', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-full-'));
  fs.writeFileSync(path.join(dir, 'curated-software.csv'),
    'resourceName,resourceType,source,identifier,newReuse\n' +
    'MATLAB,Software/code,https://mathworks.com/matlab,RRID:SCR_001622,reuse\n'
  );
  const provider = createCsvProvider(dir);

  const raw = [
    { name: 'MATLAB R2019b', normalizedName: 'MATLAB', confidence: 0.7, context: 'first mention' },
    { name: 'MATLAB',        normalizedName: 'MATLAB', confidence: 0.9, context: 'second mention' }
  ];
  const krt = buildKrtItemsSoftware(raw);
  const { enriched } = await enrichSoftware(krt, { provider });
  const items = dedupeKrtItems(enriched, 'software');

  assert.equal(items.length, 1);
  assert.equal(items[0].mergedFrom.length, 2);
  // Highest confidence (0.9) wins for representative fields
  assert.equal(items[0].confidence, 0.9);

  fs.rmSync(dir, { recursive: true, force: true });
});
