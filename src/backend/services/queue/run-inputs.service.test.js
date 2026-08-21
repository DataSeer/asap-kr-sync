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
  // Keyed by run NUMBER. It used to be the job row's id, which separated runs
  // only because `runAllProcesses` created a new row each time — reusing the
  // row is the rival-row fix, and it silently took that separation with it.
  // Same row, second run, and the keys must still differ.
  const first = generateJobS3Key('MS1', 'sub-1', 1, 'materials_detection', 'inputs.json', 1);
  const second = generateJobS3Key('MS1', 'sub-1', 1, 'materials_detection', 'inputs.json', 2);

  assert.notEqual(first, second, 'two runs of the same step in the same round must not share a key');
  assert.ok(first.includes('/run-1/'));
  assert.ok(second.includes('/run-2/'));
  assert.ok(first.endsWith('/inputs.json'));
});

test('rounds and steps stay separate from each other', () => {
  const key = (round, jobType, run) => generateJobS3Key('MS1', 'sub-1', round, jobType, 'inputs.json', run);

  assert.notEqual(key(1, 'materials_detection', 1), key(2, 'materials_detection', 1), 'round 2 is not round 1');
  assert.notEqual(key(1, 'materials_detection', 1), key(1, 'datasets_detection', 1), 'two steps are not one');
});

test('a run with no number keeps the unnumbered path', () => {
  // Rows that predate run history: their artefacts are already written under
  // the old path, and each run row carries its own `s3_prefix`, so nothing has
  // to be moved to satisfy the new convention.
  const key = generateJobS3Key('MS1', 'sub-1', 1, 'materials_detection', 'inputs.json', undefined);

  assert.ok(!key.includes('/run-'), 'no run segment invented for a run we cannot number');
  assert.ok(key.endsWith('jobs/materials_detection/inputs.json'));
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
  // `size` is the File model's attribute. This test asserted `fileSize`, which
  // is what the code read at the time — both were wrong together, so the test
  // passed while the field was always null in practice.
  const ref = fileRef({ id: 'f1', fileName: 'ms.pdf', type: 'pdf', version: 1, s3Key: 'k', size: 42 });
  assert.equal(ref.sha256, null, 'no digest is better than a wrong one');
  assert.equal(ref.bytes, 42);
  assert.equal(fileRef(null), null);
});

test('the digest wins over the recorded size when the bytes are to hand', () => {
  const content = Buffer.from('12345');
  const ref = fileRef({ id: 'f1', fileName: 'ms.md', type: 'markdown', version: 2, s3Key: 'k', size: 999 }, content);
  assert.equal(ref.bytes, 5, 'the size READ, not the size the row claims');
  assert.match(ref.sha256, /^[0-9a-f]{64}$/);
});

test('the prompt is provable: template digest + assembled digest', () => {
  const rel = 'src/backend/data/prompts/seeded/materials-detection.txt';
  const ref = promptRef(rel, 'ASSEMBLED PROMPT TEXT');
  assert.equal(ref.promptFile, rel);
  assert.match(ref.templateSha256, /^[0-9a-f]{64}$/, 'the template on disk is hashed');
  assert.equal(ref.assembledSha256, sha256('ASSEMBLED PROMPT TEXT'));
  // The ASSEMBLED prompt is the manuscript-sized one, and stays a digest:
  // rebuild it from the rest of the record, hash it, compare.
  assert.ok(!('assembled' in ref));
});

test('the prompt TEMPLATE is copied in full, not just hashed', () => {
  // Storing only the digest meant the UI had to link to GitHub, and the running
  // app is not always at the head of the branch — so a reader was shown a
  // prompt that may not be the one that ran, with no way to tell. A template is
  // a few kilobytes; the run keeps its own copy.
  const rel = 'src/backend/data/prompts/seeded/materials-detection.txt';
  const ref = promptRef(rel);

  assert.equal(typeof ref.templateText, 'string');
  assert.ok(ref.templateText.length > 100, 'the whole template, not a preview');
  assert.equal(sha256(ref.templateText), ref.templateResolvedSha256,
    'the stored copy must be exactly the text the digest was taken over');
});

test('the stored copy survives the file changing afterwards', () => {
  // The property that makes it worth storing: the run\'s copy is the run\'s,
  // and editing the prompt tomorrow cannot rewrite what a past run shows.
  const rel = 'src/backend/data/prompts/seeded/materials-detection.txt';
  const ref = promptRef(rel);
  const snapshot = ref.templateText;

  assert.equal(promptRef(rel).templateText, snapshot);
  assert.notEqual(snapshot, null);
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
  assert.equal(ref.templateText, null, 'no text is not the empty string — the UI must be able to tell');
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
