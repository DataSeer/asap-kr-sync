/**
 * ADDITIONAL INFORMATION must survive LM consolidation.
 *
 * `buildKrtFromLM` rebuilds each row from its contributors by enumerating
 * fields, so any field nobody enumerates is lost. It listed five and omitted
 * this one, which meant every resource the LM PLACED lost it while the
 * safety-net path below kept it — one output table, two item shapes.
 *
 * Downstream, `makeAddSuggestion` reads it as the suggestion's `context`, the
 * hover blurb shown next to an ADD suggestion, so it was always null.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtFromLM } = require('./krt-generation.service');

const candidate = (over = {}) => ({
  dedupKey: 'k1',
  resourceType: 'Antibody',
  resourceName: 'anti-TH',
  sourceUrl: 'Millipore',
  identifier: 'RRID:AB_2201407',
  newReuse: 'reuse',
  additionalInformation: 'Used at 1:1,000',
  confidence: 0.9,
  detectedBy: [{ source: 'materials', confidence: 0.9, originalItem: {} }],
  ...over
});

test('a resource the LM placed keeps additionalInformation', () => {
  const { items } = buildKrtFromLM([candidate()], {
    resources: [{ refs: [0], resourceName: 'anti-TH', reason: 'kept' }]
  });
  assert.equal(items[0].additionalInformation, 'Used at 1:1,000');
});

test('the safety-net path keeps it too, and both shapes agree', () => {
  const placed = buildKrtFromLM([candidate()], {
    resources: [{ refs: [0], resourceName: 'anti-TH', reason: 'kept' }]
  });
  const net = buildKrtFromLM([candidate()], { resources: [] });
  assert.equal(net.items[0].additionalInformation, 'Used at 1:1,000');
  assert.deepEqual(
    Object.keys(placed.items[0]).sort(),
    Object.keys(net.items[0]).sort(),
    'both paths must emit the same fields, or consumers see a column that exists on some rows only'
  );
});

test("the LM's own value wins over the detectors'", () => {
  const { items } = buildKrtFromLM([candidate()], {
    resources: [{ refs: [0], resourceName: 'anti-TH', additionalInformation: 'curated', reason: 'kept' }]
  });
  assert.equal(items[0].additionalInformation, 'curated');
});

test('merging two contributors keeps both blurbs', () => {
  const { items } = buildKrtFromLM(
    [candidate(), candidate({ dedupKey: 'k2', additionalInformation: 'Lot 42' })],
    { resources: [{ refs: [0, 1], resourceName: 'anti-TH', reason: 'merged' }] }
  );
  assert.match(items[0].additionalInformation, /Used at 1:1,000/);
  assert.match(items[0].additionalInformation, /Lot 42/);
});
