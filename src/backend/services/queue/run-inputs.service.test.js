/**
 * The audit record, and the one property that makes it an audit record: a
 * re-run must not be able to change what an earlier run says it read.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { sha256, fileRef, promptRef, upstreamRefs } = require('./run-inputs.service');
const { generateJobS3Key } = require('../../utils/helpers');

test('artefact keys are per RUN, so a re-run cannot overwrite the last one', () => {
  const a = generateJobS3Key('MS1', 'sub-1', 1, 'materials_detection', 'inputs.json', 'job-a');
  const b = generateJobS3Key('MS1', 'sub-1', 1, 'materials_detection', 'inputs.json', 'job-b');
  assert.notEqual(a, b, 'two runs of the same step in the same round must not share a key');
  assert.ok(a.includes('/job-a/'));
  assert.ok(a.endsWith('/inputs.json'));
});

test('a file is recorded by identity and digest, not copied', () => {
  const content = Buffer.from('# Manuscript\n\nanti-TagFP (RRID:AB_2313584)');
  const ref = fileRef(
    { id: 'f1', fileName: 'ms.md', type: 'markdown', version: 3, s3Key: 'k', fileSize: 999 },
    content
  );
  assert.equal(ref.version, 3);
  assert.equal(ref.bytes, content.length, 'the size read, not the size recorded on the row');
  assert.equal(ref.sha256, sha256(content));
  assert.ok(!('content' in ref), 'the bytes themselves must not be duplicated here');
});

test('a file with no bytes to hand still records what it was', () => {
  const ref = fileRef({ id: 'f1', fileName: 'ms.pdf', type: 'pdf', version: 1, s3Key: 'k', fileSize: 42 });
  assert.equal(ref.sha256, null, 'no digest is better than a wrong one');
  assert.equal(ref.bytes, 42);
  assert.equal(fileRef(null), null);
});

test('the prompt is provable: template digest + assembled digest', () => {
  const rel = 'src/backend/data/prompts/seeded/materials-detection.txt';
  const ref = promptRef(rel, 'ASSEMBLED PROMPT TEXT');
  assert.equal(ref.promptFile, rel);
  assert.match(ref.templateSha256, /^[0-9a-f]{64}$/, 'the template on disk is hashed');
  assert.equal(ref.assembledSha256, sha256('ASSEMBLED PROMPT TEXT'));
  // Rebuild → hash → compare is the whole point; storing the text is not needed.
  assert.ok(!('assembled' in ref));
});

test('a precomputed digest is accepted, so the prompt need not travel', () => {
  const rel = 'src/backend/data/prompts/seeded/materials-detection.txt';
  const ref = promptRef(rel, { sha256: 'a'.repeat(64), bytes: 1234 });
  assert.equal(ref.assembledSha256, 'a'.repeat(64));
  assert.equal(ref.assembledBytes, 1234);
});

test('a missing prompt file degrades to null rather than throwing', () => {
  const ref = promptRef('does/not/exist.txt');
  assert.equal(ref.templateSha256, null);
  assert.equal(promptRef(null).promptFile, null);
});

test('upstream contributions are recorded as run references', () => {
  const refs = upstreamRefs([
    { source: 'materials_detection', jobId: 'j1', items: [1, 2, 3] },
    { source: 'software_detection', count: 7 }
  ]);
  assert.deepEqual(refs[0], { source: 'materials_detection', jobId: 'j1', itemCount: 3 });
  assert.equal(refs[1].jobId, null, 'an unknown run is null, not omitted');
  assert.equal(refs[1].itemCount, 7);
});
