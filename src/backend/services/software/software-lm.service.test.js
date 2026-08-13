/**
 * Tests for the software LM pass.
 *
 * This pass exists to catch what Softcite structurally cannot — identifiers,
 * repo links, custom code — so the cases worth pinning are the shape of its
 * output and its refusal to invent anything.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKrtItemsSoftwareLM, parseResponse } = require('./software-lm.service');

test('builds canonical KrtEntry rows tagged with their own origin', () => {
  const [item] = buildKrtItemsSoftwareLM([{
    canonical_name: 'CellProfiler',
    aliases: ['Cell Profiler'],
    version: '4.2.1',
    newReuse: 'reuse',
    source: 'cellprofiler.org',
    identifier: 'RRID:SCR_007358',
    evidence_quote: 'images were analysed in CellProfiler 4.2.1',
    krt_relevance: 'HIGH'
  }]);

  assert.equal(item.resourceType, 'Software/code');
  assert.equal(item.resourceName, 'CellProfiler');
  assert.equal(item.identifier, 'RRID:SCR_007358');
  assert.equal(item.origin, 'software-lm', 'must be distinguishable from a Softcite find');
  assert.equal(item.newReuse, 'reuse');
  assert.equal(item.confidence, 0.95);
  assert.equal(item.detectorMeta.version, '4.2.1');
  assert.deepEqual(item.detectorMeta.aliases, ['Cell Profiler']);
  // Unresolved evidence — attachEvidence verifies it against the manuscript.
  assert.equal(item.evidence.quote, 'images were analysed in CellProfiler 4.2.1');
  assert.equal(item.evidence.match, null);
});

test('a self-alias is stripped', () => {
  const [item] = buildKrtItemsSoftwareLM([
    { canonical_name: 'Fiji', aliases: ['Fiji', 'FIJI', 'ImageJ/FIJI'] }
  ]);
  assert.deepEqual(item.detectorMeta.aliases, ['ImageJ/FIJI']);
});

test('newReuse defaults to reuse and only "new" opts out', () => {
  assert.equal(buildKrtItemsSoftwareLM([{ canonical_name: 'X' }])[0].newReuse, 'reuse');
  assert.equal(buildKrtItemsSoftwareLM([{ canonical_name: 'X', newReuse: 'anything' }])[0].newReuse, 'reuse');
  assert.equal(buildKrtItemsSoftwareLM([{ canonical_name: 'X', newReuse: 'new' }])[0].newReuse, 'new');
});

test('rows without a name are dropped', () => {
  assert.deepEqual(buildKrtItemsSoftwareLM([{ identifier: 'RRID:SCR_1' }, { canonical_name: '  ' }]), []);
});

test('missing fields become empty strings, never undefined or invented', () => {
  const [item] = buildKrtItemsSoftwareLM([{ canonical_name: 'Custom analysis scripts' }]);
  assert.equal(item.identifier, '');
  assert.equal(item.source, '');
  assert.equal(item.detectorMeta.version, '');
  assert.deepEqual(item.detectorMeta.aliases, []);
});

test('tolerates junk input', () => {
  assert.deepEqual(buildKrtItemsSoftwareLM(null), []);
  assert.deepEqual(buildKrtItemsSoftwareLM([]), []);
});

test('parseResponse reads the documented shape and a fenced block', () => {
  assert.equal(parseResponse('{"resources":[{"canonical_name":"R"}]}').length, 1);
  assert.equal(parseResponse('```json\n{"resources":[{"canonical_name":"R"}]}\n```').length, 1);
  assert.equal(parseResponse('[{"canonical_name":"R"}]').length, 1);
});

test('parseResponse salvages a truncated response instead of losing everything', () => {
  const truncated = '{"resources":[{"canonical_name":"Fiji"},{"canonical_name":"DESeq2"},{"canonical_name":"trunc';
  const out = parseResponse(truncated);
  assert.equal(out.length, 2);
  assert.equal(out[1].canonical_name, 'DESeq2');
});

test('parseResponse returns [] on junk rather than throwing', () => {
  assert.deepEqual(parseResponse(''), []);
  assert.deepEqual(parseResponse('not json'), []);
  assert.deepEqual(parseResponse('{"resources":"nope"}'), []);
});
