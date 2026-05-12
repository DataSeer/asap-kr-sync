/**
 * Tests for the protocols pipeline steps.
 *
 * Covers the pure steps (buildKrtItemsProtocols, enrichProtocols) that don't
 * need Gemini / DB. detectProtocols (Gemini) and detectProtocolsForSubmission
 * (S3 + DB) are exercised through the worker integration tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildKrtItemsProtocols,
  enrichProtocols
} = require('./protocols.service');
const { createCsvProvider } = require('../enrichment-list-providers');

test('buildKrtItemsProtocols: empty / non-array input → []', () => {
  assert.deepEqual(buildKrtItemsProtocols([]), []);
  assert.deepEqual(buildKrtItemsProtocols(null), []);
  assert.deepEqual(buildKrtItemsProtocols(undefined), []);
});

test('buildKrtItemsProtocols: prompt-shape → canonical KrtEntry', () => {
  const raw = [{
    canonical_name: 'Western Blot',
    resource_type: 'Protocol',
    source: 'protocols.io',
    identifier: 'doi:10.17504/abc',
    newReuse: 'reuse',
    krt_relevance: 'HIGH',
    text_excerpt: 'WB was performed as in (Doe et al. 2020)…',
    aliases: ['WB']
  }];
  const items = buildKrtItemsProtocols(raw);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.resourceType, 'Protocol');
  assert.equal(item.resourceName, 'Western Blot');
  assert.equal(item.source, 'protocols.io');
  assert.equal(item.identifier, 'doi:10.17504/abc');
  assert.equal(item.newReuse, 'reuse');
  assert.equal(item.origin, 'protocols-gemini');
  assert.equal(item.confidence, 0.95);
  assert.equal(item.additionalInformation, 'WB was performed as in (Doe et al. 2020)…');
  assert.equal(item.detectorMeta.relevance, 'HIGH');
  assert.deepEqual(item.detectorMeta.aliases, ['WB']);
});

test('buildKrtItemsProtocols: krt_relevance MEDIUM/LOW map to confidence', () => {
  const items = buildKrtItemsProtocols([
    { canonical_name: 'A', krt_relevance: 'MEDIUM' },
    { canonical_name: 'B', krt_relevance: 'LOW' }
  ]);
  assert.equal(items[0].confidence, 0.7);
  assert.equal(items[1].confidence, 0.4);
});

test('buildKrtItemsProtocols: missing krt_relevance → default confidence', () => {
  const items = buildKrtItemsProtocols([{ canonical_name: 'A' }]);
  assert.equal(items[0].confidence, 0.7); // DEFAULT_CONFIDENCE
});

test('buildKrtItemsProtocols: accepts canonical fields too (idempotent on already-shaped items)', () => {
  const items = buildKrtItemsProtocols([{
    resourceName: 'X',
    resourceType: 'Protocol',
    identifier: 'id-1',
    newReuse: 'new',
    krt_relevance: 'HIGH'
  }]);
  assert.equal(items[0].resourceName, 'X');
  assert.equal(items[0].resourceType, 'Protocol');
  assert.equal(items[0].newReuse, 'new');
});

test('buildKrtItemsProtocols: defaults resourceType to Protocol when missing', () => {
  const items = buildKrtItemsProtocols([{ canonical_name: 'X' }]);
  assert.equal(items[0].resourceType, 'Protocol');
});

test('enrichProtocols: fills blanks from CSV provider', async () => {
  // Build a temp dir with a curated-protocols.csv that has a matching entry.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-enrich-'));
  fs.writeFileSync(path.join(dir, 'curated-protocols.csv'),
    'resourceName,resourceType,source,identifier,newReuse\n' +
    'Western Blot,Protocol,protocols.io,doi:10.17504/wb,reuse\n'
  );
  const provider = createCsvProvider(dir);

  const items = buildKrtItemsProtocols([{ canonical_name: 'Western Blot' }]);
  const { enriched } = await enrichProtocols(items, { provider });

  assert.equal(enriched.length, 1);
  // Blanks filled from curated list
  assert.equal(enriched[0].source, 'protocols.io');
  assert.equal(enriched[0].identifier, 'doi:10.17504/wb');
  assert.equal(enriched[0].newReuse, 'reuse');
  // Provenance lives under detectorMeta, not at top level
  assert.ok(enriched[0].detectorMeta.enrichmentMeta);
  assert.equal(enriched[0].detectorMeta.enrichmentMeta.matched, true);
  assert.ok(enriched[0].detectorMeta.customListMatch);
  assert.equal(enriched[0].customListMatch, undefined);
  assert.equal(enriched[0].enrichmentMeta, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('enrichProtocols: no match → item unchanged except detectorMeta.enrichmentMeta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-enrich-nomatch-'));
  fs.writeFileSync(path.join(dir, 'curated-protocols.csv'),
    'resourceName,resourceType,source,identifier,newReuse\n' +
    'Something Else,Protocol,elsewhere,id-x,reuse\n'
  );
  const provider = createCsvProvider(dir);

  const items = buildKrtItemsProtocols([{ canonical_name: 'Mystery Protocol', identifier: 'orig' }]);
  const { enriched } = await enrichProtocols(items, { provider });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].resourceName, 'Mystery Protocol');
  assert.equal(enriched[0].identifier, 'orig');
  assert.equal(enriched[0].detectorMeta.enrichmentMeta.matched, false);

  fs.rmSync(dir, { recursive: true, force: true });
});
