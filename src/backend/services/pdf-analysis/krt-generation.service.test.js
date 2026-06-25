/**
 * Tests for the pure KRT-generation mapper (no LM, no DB).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtFromLM } = require('./krt-generation.service');

const candidates = [
  { resourceType: 'Software/code', resourceName: 'Fiji', sourceUrl: '', identifier: 'RRID:SCR_1', newReuse: 'reuse', detectedBy: [{ source: 'software_detection' }], confidence: 0.7 },
  { resourceType: 'Software/code', resourceName: 'Fiji (ImageJ)', sourceUrl: '', identifier: '', newReuse: 'reuse', detectedBy: [{ source: 'identifier_detection' }], confidence: 0.9 },
  { resourceType: 'Dataset', resourceName: 'RNA-seq', sourceUrl: 'GEO', identifier: 'GSE1', newReuse: 'new', detectedBy: [{ source: 'datasets_detection' }], confidence: 0.8 }
];

test('merges refs into one item, unions provenance, attaches reason', () => {
  const { items } = buildKrtFromLM(candidates, {
    resources: [
      { refs: [0, 1], resourceType: 'Software/code', resourceName: 'Fiji', source: '', identifier: 'RRID:SCR_1', newReuse: 'reuse', reason: 'merged duplicate detections' },
      { refs: [2], resourceType: 'Dataset', resourceName: 'RNA-seq', source: 'GEO', identifier: 'GSE1', newReuse: 'new', reason: 'kept' }
    ],
    dropped: []
  });
  assert.equal(items.length, 2);
  const fiji = items[0];
  assert.equal(fiji.resourceName, 'Fiji');
  assert.equal(fiji.reason, 'merged duplicate detections');
  // provenance unioned from both refs
  const sources = fiji.detectedBy.map(d => d.source);
  assert.ok(sources.includes('software_detection') && sources.includes('identifier_detection'));
});

test('dropped candidate is recorded with reason + provenance', () => {
  const { items, dropped } = buildKrtFromLM(candidates, {
    resources: [{ refs: [2], resourceName: 'RNA-seq', resourceType: 'Dataset', identifier: 'GSE1', newReuse: 'new', source: 'GEO', reason: 'kept' }],
    dropped: [{ ref: 0, reason: 'fragment' }, { ref: 1, reason: 'fragment' }]
  });
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0].reason, 'fragment');
  assert.equal(dropped[0].resourceName, 'Fiji');
  assert.deepEqual(dropped[0].sources, ['software_detection']); // enriched from candidate provenance
  assert.equal(items.length, 1);
});

test('internal ref numbers are scrubbed from reasons', () => {
  const { items, dropped } = buildKrtFromLM(candidates, {
    resources: [{ refs: [0, 1], resourceName: 'Fiji', resourceType: 'Software/code', identifier: 'RRID:SCR_1', newReuse: 'reuse', source: '', reason: 'merged duplicate detections (refs 0 and 1)' }],
    dropped: [{ ref: 2, reason: 'dropped ref 2 — fragment' }]
  });
  assert.ok(!/ref/i.test(items[0].reason), `reason still mentions ref: "${items[0].reason}"`);
  assert.equal(items[0].reason, 'merged duplicate detections');
  assert.ok(!/ref/i.test(dropped[0].reason), `dropped reason still mentions ref: "${dropped[0].reason}"`);
});

test('safety net: candidate the LM forgot is kept', () => {
  const { items } = buildKrtFromLM(candidates, {
    resources: [{ refs: [0], resourceName: 'Fiji', resourceType: 'Software/code', identifier: 'RRID:SCR_1', newReuse: 'reuse', source: '', reason: 'kept' }],
    dropped: []
  });
  // refs 1 and 2 were neither placed nor dropped → kept as-is
  assert.equal(items.length, 3);
});

test('empty / malformed LM output → all candidates kept (safety)', () => {
  const { items } = buildKrtFromLM(candidates, {});
  assert.equal(items.length, candidates.length);
});
