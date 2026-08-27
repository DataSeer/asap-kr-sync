'use strict';

/**
 * Who asked for each step to run.
 *
 * `userId` was threaded from every controller through the whole orchestrator
 * and then dropped on the floor — eleven of twelve steps never carried it into
 * their payload, the twelfth carried it and never read it, and no column held
 * it. These tests pin the rule that makes the column trustworthy:
 *
 *   a step is credited to the user who asked for it, and an advance with no
 *   user attached NEVER erases the credit already there.
 *
 * That second half is the one worth pinning. Most advances are worker-driven
 * and carry no user; a plain assignment would blank the attribution moments
 * after the pipeline recorded it, leaving every finished run credited to
 * nobody — and looking, from the outside, exactly like a feature that works.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob, Submission, sequelize } = require('../../models');
const orchestrator = require('./orchestrator.service');
const jobQueue = require('./job-queue.service');
const { JOB_TYPES } = require('../../config/constants');
const { fakePipelineRuns } = require('../../test-helpers/fake-pipeline-runs');

const STARTER = 'user-who-started';
const CURATOR = 'user-who-restarted';
const OWNER = 'user-who-owns-the-submission';

function row(jobType, over = {}) {
  return {
    id: `${jobType}-row`,
    jobType,
    submissionId: 'sub-1',
    round: 1,
    status: 'waiting',
    pgBossJobId: null,
    result: null,
    errorMessage: null,
    triggeredByUserId: null,
    createdAt: new Date('2026-08-21T00:00:00Z'),
    async save() { return this; },
    async markCancelled() { this.status = 'cancelled'; },
    async markPendingInput() { this.status = 'pending_input'; }
  , ...over };
}

function pipelineRows(over = {}) {
  const rows = new Map();
  for (const step of orchestrator.PIPELINE) rows.set(step.jobType, row(step.jobType));
  for (const [jobType, patch] of Object.entries(over)) rows.set(jobType, row(jobType, patch));
  return rows;
}

function mockDb(t, rows, submission = { id: 'sub-1', status: 'step_pdf', dataAvailabilityStatement: 'Data are available at Zenodo.' }) {
  // Credit is what these tests are about; opening a pipeline run is not, and
  // it reaches for a connection on every entry point.
  fakePipelineRuns(t);
  t.mock.method(SubmissionJob, 'getForSubmission', async () => [...rows.values()]);
  t.mock.method(SubmissionJob, 'findAll', async () => [...rows.values()]);
  t.mock.method(SubmissionJob, 'getLatest', async (_s, jobType) => rows.get(jobType) || null);
  t.mock.method(SubmissionJob, 'create', async (attrs) => {
    const created = row(attrs.jobType, attrs);
    rows.set(attrs.jobType, created);
    return created;
  });
  t.mock.method(SubmissionJob, 'update', async (values, { where } = {}) => {
    const target = [...rows.values()].find((r) => r.id === where.id);
    if (!target) return [0];
    if (where.status !== undefined && target.status !== where.status) return [0];
    Object.assign(target, values);
    return [1];
  });
  t.mock.method(Submission, 'findByPk', async () => submission);
  t.mock.method(jobQueue, 'addJob', async () => 'pgboss-1');
  // cascadeRestart reads each downstream row through findOne, inside a real
  // transaction with a row lock. Both have to be answered or the call reaches
  // Postgres and the test fails on a hostname rather than on behaviour.
  t.mock.method(SubmissionJob, 'findOne', async ({ where }) => rows.get(where.jobType) || null);
  t.mock.method(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
  return rows;
}

/** Mark a step's dependencies complete so it is actually advanceable. */
function completeUpstreamOf(rows, jobType, seen = new Set()) {
  const step = orchestrator.PIPELINE.find((s) => s.jobType === jobType);
  for (const dep of step.dependsOn) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    completeUpstreamOf(rows, dep, seen);
    const r = rows.get(dep);
    r.status = 'complete';
    r.result = {
      status: { detected: true, characters: 5000 },
      data: { meta: { characters: 5000 }, das: 'Data are available at Zenodo.' }
    };
  }
}

test('starting a pipeline credits every step to the person who started it', async (t) => {
  const rows = new Map();
  mockDb(t, rows);

  await orchestrator.runAllProcesses('sub-1', STARTER, 1);

  const credited = [...rows.values()].map((r) => r.triggeredByUserId);
  assert.equal(credited.length, orchestrator.PIPELINE.length);
  assert.ok(credited.every((u) => u === STARTER), 'every seeded row carries the starter');
});

test('re-starting a pipeline re-credits it to whoever restarted', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) { r.triggeredByUserId = STARTER; r.status = 'complete'; }
  mockDb(t, rows);

  await orchestrator.runAllProcesses('sub-1', CURATOR, 1);

  assert.ok([...rows.values()].every((r) => r.triggeredByUserId === CURATOR));
});

test('a pipeline started with no user leaves the credit empty rather than undefined', async (t) => {
  const rows = new Map();
  mockDb(t, rows);

  await orchestrator.runAllProcesses('sub-1', undefined, 1);

  assert.ok([...rows.values()].every((r) => r.triggeredByUserId === null),
    'null is storable; undefined is not a value the column can hold');
});

test('re-running one step credits the caller, not the round starter', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) r.triggeredByUserId = STARTER;
  completeUpstreamOf(rows, JOB_TYPES.MATERIALS_DETECTION);
  rows.get(JOB_TYPES.MATERIALS_DETECTION).status = 'complete';
  mockDb(t, rows);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1, CURATOR);

  assert.equal(rows.get(JOB_TYPES.MATERIALS_DETECTION).triggeredByUserId, CURATOR);
  assert.equal(rows.get(JOB_TYPES.SOFTWARE_DETECTION).triggeredByUserId, STARTER,
    'a step that is neither re-run nor downstream keeps its original credit');
});

test('a cascade is credited to whoever set it off', async (t) => {
  // Asking for one step to re-run is asking for everything downstream of it to
  // re-run too. Those are real model calls, really paid for, and the person who
  // caused them is the one who clicked — not whoever happened to start the
  // round hours earlier.
  const rows = pipelineRows();
  for (const r of rows.values()) { r.triggeredByUserId = STARTER; r.status = 'complete'; }
  mockDb(t, rows);

  const reset = await orchestrator.cascadeRestart('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1, CURATOR);

  assert.ok(reset.includes(JOB_TYPES.PDF_ANALYSIS), 'the consolidator is downstream of a detector');
  for (const jobType of reset) {
    assert.equal(rows.get(jobType).triggeredByUserId, CURATOR,
      `${jobType} was re-run because of the curator, so it is credited to them`);
  }
  assert.equal(rows.get(JOB_TYPES.SOFTWARE_DETECTION).triggeredByUserId, STARTER,
    'a sibling detector is not downstream and must not be re-credited');
});

test('a cascade with no user attached re-credits nobody', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) { r.triggeredByUserId = STARTER; r.status = 'complete'; }
  mockDb(t, rows);

  await orchestrator.cascadeRestart('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1);

  assert.ok([...rows.values()].every((r) => r.triggeredByUserId === STARTER),
    'the same no-overwrite rule as every other write path');
});

test('a cascade does not credit a step it left alone', async (t) => {
  // An in-flight row is deliberately skipped by the reset. A row this cascade
  // did not touch must not be attributed to it either — otherwise the credit
  // says someone re-ran a result that is in fact the older run's.
  const rows = pipelineRows();
  for (const r of rows.values()) { r.triggeredByUserId = STARTER; r.status = 'complete'; }
  rows.get(JOB_TYPES.PDF_ANALYSIS).status = 'processing';
  mockDb(t, rows);

  const reset = await orchestrator.cascadeRestart('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1, CURATOR);

  assert.ok(!reset.includes(JOB_TYPES.PDF_ANALYSIS));
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).triggeredByUserId, STARTER,
    'a running step keeps its own run\'s credit');
});

test('a cancelled step IS revived, and credited to whoever revived it', async (t) => {
  // Cancelled used to be skipped alongside in-flight, which left a cancelled
  // dependent stuck for ever once the step it waited on was restarted. It is
  // reset now, so it is also re-credited: this person caused it to run.
  const rows = pipelineRows();
  for (const r of rows.values()) { r.triggeredByUserId = STARTER; r.status = 'complete'; }
  rows.get(JOB_TYPES.SUGGESTION_GENERATION).status = 'cancelled';
  mockDb(t, rows);

  const reset = await orchestrator.cascadeRestart('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1, CURATOR);

  assert.ok(reset.includes(JOB_TYPES.SUGGESTION_GENERATION));
  assert.equal(rows.get(JOB_TYPES.SUGGESTION_GENERATION).status, 'waiting');
  assert.equal(rows.get(JOB_TYPES.SUGGESTION_GENERATION).triggeredByUserId, CURATOR);
});

test('an automatic advance keeps the credit it already had', async (t) => {
  // THE case this column gets wrong. checkAndAdvance runs on every worker
  // completion and passes no user; a plain `set` would wipe the starter out
  // seconds after the pipeline recorded them.
  const rows = pipelineRows();
  for (const r of rows.values()) r.triggeredByUserId = STARTER;
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);

  // From a real dependency of the consolidator. Grounding stopped being one
  // when it and consolidation were parallelised, so advancing from it no longer
  // queues this step and the assertion below would pass vacuously.
  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.IDENTIFIER_DETECTION, 1);

  const analysis = rows.get(JOB_TYPES.PDF_ANALYSIS);
  assert.equal(analysis.status, 'queued', 'the step did advance');
  assert.equal(analysis.triggeredByUserId, STARTER,
    'an advance with no user must not erase the credit');
});

test('a manual advance of a parked step credits whoever released it', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) r.triggeredByUserId = STARTER;
  rows.get(JOB_TYPES.PDF_ANALYSIS).status = 'pending_input';
  mockDb(t, rows);

  await orchestrator.advanceJob('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, CURATOR);

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).triggeredByUserId, CURATOR,
    'typing the missing statement is what released it');
});

test('the reconciler credits nobody, least of all the submission owner', async (t) => {
  // reconcileStuckJobs hands reconcileSubmission the SUBMISSION'S OWNER as
  // `userId` — it needs a user for the job payload — and the sweep is then
  // indistinguishable from a person clicking. Crediting it is wrong twice
  // over: the owner did not ask for the re-drive, and the sweep runs on a
  // timer, so it would silently overwrite the curator who actually did.
  const rows = pipelineRows();
  for (const r of rows.values()) r.triggeredByUserId = CURATOR;
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);

  const advanced = await orchestrator.reconcileSubmission('sub-1', 1, OWNER);

  assert.ok(advanced > 0, 'the sweep must actually re-drive something for this to mean anything');
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).triggeredByUserId, CURATOR,
    'an automatic re-drive must not take the credit from whoever caused the run');
});
