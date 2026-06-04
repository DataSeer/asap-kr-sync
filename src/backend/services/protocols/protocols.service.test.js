/**
 * Tests for the protocols pipeline steps.
 *
 * Covers the pure step buildKrtItemsProtocols (no Gemini / DB). detectProtocols
 * (Gemini) and detectProtocolsForSubmission (S3 + DB) are exercised through the
 * worker integration tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtItemsProtocols } = require('./protocols.service');

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
  // Per ASAP request: text excerpt is preserved on detectorMeta.context
  // for the internal panel but kept out of user-facing ADDITIONAL INFORMATION.
  assert.equal(item.additionalInformation, '');
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
