/**
 * Which strategy a submission's run uses, and whether it may run at all.
 *
 * One place decides, so a detector never has to know pipelines exist. Two
 * things must hold: the submission's OWN pipeline decides (not a default that
 * quietly differs), and a detector that cannot run says so instead of running
 * with the wrong input.
 *
 * `detectionPromptsExist` is the second half of that. It replaced a check that
 * tested the BLIND consolidation prompt while the default pipeline is seeded —
 * so a missing blind file silently downgraded a runnable seeded detection to
 * demo data, and a missing SEEDED file was reported as available and threw
 * mid-run.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { KRTData } = require('../../models');
const { resolveDetection, detectionPromptsExist } = require('./resolve');
const { getStrategy } = require('./registry');

const DETECTORS = ['materials', 'protocols', 'datasets'];

/**
 * The seeded strategies load the author's rows to build their seeds, so
 * resolving one touches the database. Stubbed at the model, which works
 * regardless of how the strategy imported the loader.
 */
function noAuthorRows(t) {
  t.mock.method(KRTData, 'findAll', async () => []);
}
const submission = (over = {}) => ({ id: 'sub-1', currentRound: 1, status: 'step_pdf', ...over });
const ctx = (over = {}) => ({ submission: submission(), markdownText: 'The manuscript text.', ...over });

// ─────────────────────────────────────────────────────────────────────────────
// Which strategy
// ─────────────────────────────────────────────────────────────────────────────

test('an unstamped submission resolves to the default pipeline', async (t) => {
  noAuthorRows(t);
  // `pipelineId` is undefined until a submission is stamped, and that must work
  // rather than throw — it is the state every existing row is in.
  const resolved = await resolveDetection('datasets', ctx({ submission: submission({ pipelineId: undefined }) }));

  assert.equal(resolved.pipeline.isDefault, true);
  assert.equal(resolved.strategy.id, 'datasets.seeded');
});

test('the submission\'s own pipeline decides, for every detector', async (t) => {
  noAuthorRows(t);
  for (const detector of DETECTORS) {
    const seeded = await resolveDetection(detector, ctx({ submission: submission({ pipelineId: 'seeded-v1' }) }));
    const blind = await resolveDetection(detector, ctx({ submission: submission({ pipelineId: 'blind-v1' }) }));

    assert.equal(seeded.strategy.id, `${detector}.seeded`);
    assert.equal(blind.strategy.id, `${detector}.blind`);
  }
});

test('an unknown pipeline is not silently replaced by the default', async (t) => {
  noAuthorRows(t);
  // Falling back would mean a submission detecting differently from what its
  // own record says, which is unauditable.
  await assert.rejects(
    () => resolveDetection('datasets', ctx({ submission: submission({ pipelineId: 'does-not-exist' }) }))
  );
});

test('a resolved run carries the prompt, the seeds and the provenance', async (t) => {
  noAuthorRows(t);
  const resolved = await resolveDetection('datasets', ctx({ submission: submission({ pipelineId: 'seeded-v1' }) }));

  assert.equal(resolved.run, true);
  assert.ok(resolved.input.prompt.length > 0, 'a run with no prompt is not a run');
  assert.ok(Array.isArray(resolved.input.seeds));
  assert.ok(resolved.input.meta.promptFile, 'the audit record needs the file it came from');
});

test('the blind pipeline sends no seeds', async (t) => {
  noAuthorRows(t);
  // The whole point of it: detection never sees the author's table.
  for (const detector of DETECTORS) {
    const resolved = await resolveDetection(detector, ctx({ submission: submission({ pipelineId: 'blind-v1' }) }));
    assert.equal(resolved.input.meta.seedCount ?? 0, 0, `${detector} must be unseeded under blind-v1`);
  }
});

test('a strategy that declines to run says why, and hands back no input', async (t) => {
  const strategy = getStrategy('datasets.seeded');
  t.mock.method(strategy, 'shouldRun', async () => ({ run: false, reason: 'nothing to do' }));

  const resolved = await resolveDetection('datasets', ctx());

  assert.equal(resolved.run, false);
  assert.equal(resolved.reason, 'nothing to do');
  assert.equal(resolved.input, undefined, 'a declined run must not carry a prompt to use anyway');
});

// ─────────────────────────────────────────────────────────────────────────────
// Whether it may run — detectionPromptsExist
// ─────────────────────────────────────────────────────────────────────────────

test('every detector reports available when its prompts are on disk', () => {
  for (const pipelineId of ['seeded-v1', 'blind-v1']) {
    for (const detector of DETECTORS) {
      assert.equal(
        detectionPromptsExist(detector, submission({ pipelineId })), true,
        `${detector} under ${pipelineId} must be available — its prompts are committed`
      );
    }
  }
});

test('it asks about the file the SUBMISSION\'S pipeline would read', async (t) => {
  // The bug it replaced: the gate tested the blind prompt while the run used
  // the seeded one. Removing the seeded file must make the seeded run
  // unavailable and leave the blind run alone.
  const seededFile = getStrategy('datasets.seeded').promptFiles[0];
  t.mock.method(fs, 'existsSync', (file) => file !== seededFile);

  assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: 'seeded-v1' })), false);
  assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: 'blind-v1' })), true);
});

test('and the reverse: a missing blind prompt does not disable the seeded run', () => {
  const blindFile = getStrategy('datasets.blind').promptFiles[0];
  const original = fs.existsSync;
  fs.existsSync = (file) => (file === blindFile ? false : original(file));
  try {
    assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: 'seeded-v1' })), true,
      'the seeded run was being downgraded to demo data by an unrelated missing file');
    assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: 'blind-v1' })), false);
  } finally {
    fs.existsSync = original;
  }
});

test('a strategy needing several prompts requires ALL of them', (t) => {
  // materials.seeded reads two files; either one missing means it cannot run.
  const [first, second] = getStrategy('materials.seeded').promptFiles;
  assert.ok(second, 'this test assumes materials.seeded declares two prompt files');

  t.mock.method(fs, 'existsSync', (file) => file !== second);
  assert.equal(detectionPromptsExist('materials', submission({ pipelineId: 'seeded-v1' })), false);

  t.mock.restoreAll();
  t.mock.method(fs, 'existsSync', (file) => file !== first);
  assert.equal(detectionPromptsExist('materials', submission({ pipelineId: 'seeded-v1' })), false);
});

test('an unstamped submission is judged by the default pipeline\'s prompts', () => {
  assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: undefined })), true);
  assert.equal(detectionPromptsExist('datasets', {}), true);
});

test('a detector the pipeline has no strategy for is not available', () => {
  assert.equal(detectionPromptsExist('not_a_detector', submission({ pipelineId: 'seeded-v1' })), false);
});

test('a missing SIGNALS prompt makes the module unavailable too', () => {
  // Datasets reads two prompts. Only the consolidation one used to be
  // declared, so this returned "available" with the signals prompt missing —
  // buildInput then threw ENOENT and the run fell through to demo data,
  // serving demo rows for a real manuscript.
  const signals = getStrategy('datasets.seeded').signalsPromptFiles[0];
  const original = fs.existsSync;
  fs.existsSync = (file) => (file === signals ? false : original(file));
  try {
    assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: 'seeded-v1' })), false);
  } finally {
    fs.existsSync = original;
  }
});

test('a strategy declaring no prompts at all is not "available"', () => {
  // `[].every()` is true, so an empty list used to read as satisfied — the same
  // masking shape as the missing signals prompt.
  const strategy = getStrategy('datasets.seeded');
  const promptFiles = strategy.promptFiles;
  const signalsPromptFiles = strategy.signalsPromptFiles;
  strategy.promptFiles = [];
  strategy.signalsPromptFiles = [];
  try {
    assert.equal(detectionPromptsExist('datasets', submission({ pipelineId: 'seeded-v1' })), false);
  } finally {
    strategy.promptFiles = promptFiles;
    strategy.signalsPromptFiles = signalsPromptFiles;
  }
});
