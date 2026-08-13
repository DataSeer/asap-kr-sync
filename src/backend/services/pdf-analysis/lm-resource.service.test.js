/**
 * Tests for the shared LM detection contract.
 *
 * The point of this module is that every LM detector produces the SAME shape,
 * so a defect downstream shows up identically everywhere instead of five
 * different ways. The cases worth pinning are therefore: the canonical fields
 * are always present, legacy vocabularies still parse, and nothing is invented.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtItemFromLM, buildKrtItemsFromLM, readField } = require('./lm-resource.service');

const opts = { origin: 'test-gemini', defaultResourceType: 'Dataset' };

test('maps the canonical vocabulary', () => {
  const item = buildKrtItemFromLM({
    name: 'CellProfiler',
    resource_type: 'Software/code',
    new_reuse: 'reuse',
    source: 'cellprofiler.org',
    identifier: 'RRID:SCR_007358',
    evidence_quote: 'analysed in CellProfiler',
    relevance: 'HIGH',
    aliases: ['Cell Profiler']
  }, opts);

  assert.equal(item.resourceName, 'CellProfiler');
  assert.equal(item.resourceType, 'Software/code');
  assert.equal(item.newReuse, 'reuse');
  assert.equal(item.identifier, 'RRID:SCR_007358');
  assert.equal(item.confidence, 0.95);
  assert.equal(item.evidence.quote, 'analysed in CellProfiler');
  assert.deepEqual(item.detectorMeta.aliases, ['Cell Profiler']);
});

test('accepts every legacy vocabulary the detectors used', () => {
  // materials/datasets/software spoke canonical_name + krt_relevance…
  const a = buildKrtItemFromLM({ canonical_name: 'X', krt_relevance: 'LOW', evidence_quote: 'q' }, opts);
  assert.equal(a.resourceName, 'X');
  assert.equal(a.confidence, 0.4);
  assert.equal(a.evidence.quote, 'q');

  // …while protocols used text_excerpt as its evidence span.
  const b = buildKrtItemFromLM({ canonical_name: 'Y', text_excerpt: 'procedural sentence' }, opts);
  assert.equal(b.evidence.quote, 'procedural sentence');

  // …and camelCase shows up in demo/legacy persisted data.
  const c = buildKrtItemFromLM({ resourceName: 'Z', resourceType: 'Protocol', newReuse: 'new' }, opts);
  assert.equal(c.resourceName, 'Z');
  assert.equal(c.resourceType, 'Protocol');
  assert.equal(c.newReuse, 'new');
});

test('a renamed field cannot silently zero a detector', () => {
  // The whole reason FIELD_ALIASES exists: an un-migrated prompt still parses.
  const legacyOnly = buildKrtItemsFromLM([
    { canonical_name: 'A' }, { name: 'B' }, { resourceName: 'C' }
  ], opts);
  assert.equal(legacyOnly.length, 3);
});

test('every entry carries the full canonical shape', () => {
  const item = buildKrtItemFromLM({ name: 'Minimal' }, opts);
  for (const field of ['resourceType', 'resourceName', 'identifier', 'source', 'newReuse',
    'origin', 'confidence', 'additionalInformation', 'evidence', 'detectorMeta']) {
    assert.ok(field in item, `missing ${field}`);
  }
  assert.equal(item.resourceType, 'Dataset', 'falls back to the module default');
  assert.equal(item.identifier, '', 'absent fields are empty strings, never undefined');
  assert.equal(item.source, '');
  assert.equal(item.evidence.match, null, 'evidence starts unresolved');
});

test('newReuse defaults to reuse; only an explicit "new" opts out', () => {
  assert.equal(buildKrtItemFromLM({ name: 'A' }, opts).newReuse, 'reuse');
  assert.equal(buildKrtItemFromLM({ name: 'A', new_reuse: 'NEW' }, opts).newReuse, 'new');
  assert.equal(buildKrtItemFromLM({ name: 'A', new_reuse: 'maybe' }, opts).newReuse, 'reuse');
});

test('an unknown relevance falls back rather than producing NaN confidence', () => {
  const item = buildKrtItemFromLM({ name: 'A', relevance: 'CRITICAL' }, opts);
  assert.equal(item.confidence, 0.7);
});

test('self-aliases are stripped', () => {
  const item = buildKrtItemFromLM({ name: 'Fiji', aliases: ['Fiji', 'FIJI', 'ImageJ/FIJI'] }, opts);
  assert.deepEqual(item.detectorMeta.aliases, ['ImageJ/FIJI']);
});

test('type-specific extras land on detectorMeta without escaping the contract', () => {
  const item = buildKrtItemFromLM(
    { name: 'RNA-seq', accessions: ['GSE1'] },
    { ...opts, details: (r) => ({ accessions: r.accessions, subtype: 'Microarray' }) }
  );
  assert.deepEqual(item.detectorMeta.accessions, ['GSE1']);
  assert.equal(item.detectorMeta.subtype, 'Microarray');
  assert.equal(item.detectorMeta.relevance, 'MEDIUM', 'shared fields still present');
});

test('nameless and malformed entries are dropped', () => {
  assert.equal(buildKrtItemFromLM({ identifier: 'RRID:SCR_1' }, opts), null);
  assert.equal(buildKrtItemFromLM({ name: '   ' }, opts), null);
  assert.equal(buildKrtItemFromLM(null, opts), null);
  assert.deepEqual(buildKrtItemsFromLM(null, opts), []);
  assert.deepEqual(buildKrtItemsFromLM([null, { name: 'ok' }], opts).map(i => i.resourceName), ['ok']);
});

test('readField honours alias priority', () => {
  assert.equal(readField({ name: 'new', canonical_name: 'old' }, 'name'), 'new');
  assert.equal(readField({ canonical_name: 'old' }, 'name'), 'old');
  assert.equal(readField({ name: '' , canonical_name: 'old' }, 'name'), 'old', 'empty is not a value');
  assert.equal(readField({}, 'name'), undefined);
});
