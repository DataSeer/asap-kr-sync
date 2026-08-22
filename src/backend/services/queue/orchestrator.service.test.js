/**
 * The pipeline's decision logic: what may start, when, and on which row.
 *
 * These are the rules a wrong answer hides behind. A step that starts too early
 * consolidates nothing and still reports success; a step that never starts
 * leaves a run that says "complete" with a piece missing. Both happened, and
 * neither showed up as an error anywhere — which is why they are pinned here
 * rather than left to the integration run to catch.
 *
 * The models are mocked at their static methods rather than behind a database.
 * That keeps the test on the logic being tested — ordering, gating, which row
 * gets written — instead of on Sequelize.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob, Submission, ChangeLog, sequelize } = require('../../models');
const jobQueue = require('./job-queue.service');
const orchestrator = require('./orchestrator.service');
const { JOB_TYPES } = require('../../config/constants');
const { fakePipelineRuns } = require('../../test-helpers/fake-pipeline-runs');

// ── a job row that behaves like the model instance the code writes to ────────
let saved;      // every row .save() was called on, in order
let enqueued;   // every queue name addJob() was called with
let pipelineRuns; // what mockDb recorded about the runs that were opened
let applied;    // every change-log row a reset hook wrote

function row(jobType, over = {}) {
  const r = {
    id: `${jobType}-row`,
    jobType,
    submissionId: 'sub-1',
    round: 1,
    status: 'waiting',
    pgBossJobId: null,
    result: null,
    // The model's field is `errorMessage` (column `error_message`). The fixture
    // said `error`, which is why the test agreed with the bug instead of
    // catching it.
    errorMessage: null,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    async save() { saved.push(this); return this; },
    async markCancelled() { this.status = 'cancelled'; saved.push(this); },
    async markPendingInput() { this.status = 'pending_input'; saved.push(this); },
    ...over
  };
  return r;
}

/** Every pipeline step present, all `waiting`, then the overrides applied. */
function pipelineRows(over = {}) {
  const rows = new Map();
  for (const step of orchestrator.PIPELINE) {
    rows.set(step.jobType, row(step.jobType));
  }
  for (const [jobType, patch] of Object.entries(over)) {
    rows.set(jobType, row(jobType, patch));
  }
  return rows;
}

/**
 * Point the model statics at an in-memory map. Returns the map so a test can
 * inspect the rows afterwards.
 */
const A_STATEMENT = 'Data are available at Zenodo.';

function mockDb(t, rows, submission = { id: 'sub-1', status: 'step_pdf', dataAvailabilityStatement: A_STATEMENT }) {
  // Every entry point opens a pipeline run before it enqueues anything. These
  // tests are about the SCHEDULER — which row is reused, what advances, who is
  // credited — so the run layer is recorded rather than exercised. The returned
  // state is what the "one restart is one run" tests below assert on.
  pipelineRuns = fakePipelineRuns(t);
  t.mock.method(SubmissionJob, 'getForSubmission', async () => [...rows.values()]);
  // runAllProcesses reads the round's existing rows before deciding whether to
  // create any, so this has to answer too.
  t.mock.method(SubmissionJob, 'findAll', async () => [...rows.values()]);
  t.mock.method(SubmissionJob, 'getLatest', async (_sub, jobType) => rows.get(jobType) || null);
  // The conditional claim tryAdvanceStep uses to take a step out of `waiting`
  // exactly once. Modelled faithfully — a fake that ignored `where.status` and
  // always answered [1] would let both racers through and pass whatever the
  // code did.
  t.mock.method(SubmissionJob, 'update', async (values, { where } = {}) => {
    const target = [...rows.values()].find((r) => r.id === where.id);
    if (!target) return [0];
    if (where.status !== undefined && target.status !== where.status) return [0];
    Object.assign(target, values);
    return [1];
  });
  t.mock.method(SubmissionJob, 'create', async (attrs) => {
    const created = row(attrs.jobType, attrs);
    rows.set(attrs.jobType, created);
    return created;
  });
  t.mock.method(Submission, 'findByPk', async () => submission);
  // cascadeRestart reads each downstream row through findOne, inside a real
  // transaction with a row lock. Both have to be answered or the call reaches
  // for a connection.
  t.mock.method(SubmissionJob, 'findOne', async ({ where }) => rows.get(where.jobType) || null);
  t.mock.method(sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
  // A step's reset hook records what it destroyed. These tests are not about
  // the log, but an unmocked create reaches for a connection.
  t.mock.method(ChangeLog, 'create', async (row) => { applied.push(row); return row; });
  t.mock.method(jobQueue, 'addJob', async (queueName) => {
    enqueued.push(queueName);
    return `pgboss-${enqueued.length}`;
  });
  return rows;
}

/**
 * Mark a step and everything it needs as complete, with the result shape each
 * dependency's own gate looks for: conversion must report characters, and DAS
 * extraction must report `detected`, or pdf_analysis parks awaiting input.
 */
function completeUpstreamOf(rows, jobType) {
  const seen = new Set();
  const walk = (type) => {
    if (seen.has(type)) return;
    seen.add(type);
    const step = orchestrator.PIPELINE.find((s) => s.jobType === type);
    for (const dep of step?.dependsOn || []) {
      rows.get(dep).status = 'complete';
      rows.get(dep).result = dep === JOB_TYPES.DAS_EXTRACTION
        ? { status: { detected: true } }
        : { data: { markdownLength: 5000 } };
      walk(dep);
    }
  };
  walk(jobType);
}

beforeEach(() => { saved = []; enqueued = []; applied = []; });
afterEach(() => { saved = []; enqueued = []; applied = []; });

// ─────────────────────────────────────────────────────────────────────────────
// computeDownstreamSet — what a re-run invalidates
// ─────────────────────────────────────────────────────────────────────────────

test('a re-run of conversion invalidates every step that reads the manuscript', () => {
  const down = orchestrator.computeDownstreamSet(JOB_TYPES.MARKDOWN_CONVERT);
  for (const jobType of [
    JOB_TYPES.DATASETS_DETECTION, JOB_TYPES.MATERIALS_DETECTION,
    JOB_TYPES.PROTOCOLS_DETECTION, JOB_TYPES.IDENTIFIER_DETECTION,
    JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.KRT_GROUNDING,
    JOB_TYPES.PDF_ANALYSIS, JOB_TYPES.SUGGESTION_GENERATION
  ]) {
    assert.ok(down.has(jobType), `${jobType} must be invalidated by a new conversion`);
  }
});

test('the set is transitive, not just the direct dependents', () => {
  // suggestion_generation depends on pdf_analysis, which depends on the
  // detectors — a detector re-run has to reach it.
  const down = orchestrator.computeDownstreamSet(JOB_TYPES.DATASETS_DETECTION);
  assert.ok(down.has(JOB_TYPES.PDF_ANALYSIS));
  assert.ok(down.has(JOB_TYPES.SUGGESTION_GENERATION));
});

test('a step never lists itself as its own downstream', () => {
  for (const step of orchestrator.PIPELINE) {
    assert.ok(
      !orchestrator.computeDownstreamSet(step.jobType).has(step.jobType),
      `${step.jobType} must not invalidate itself`
    );
  }
});

test('the last step invalidates nothing', () => {
  assert.equal(orchestrator.computeDownstreamSet(JOB_TYPES.SUGGESTION_GENERATION).size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// requeueStep — the fix for the consolidator running out of order
// ─────────────────────────────────────────────────────────────────────────────

test('requeueStep reuses the round\'s row instead of creating a second one', async (t) => {
  const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status: 'complete' } });
  mockDb(t, rows);
  const before = rows.get(JOB_TYPES.PDF_ANALYSIS);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

  assert.equal(SubmissionJob.create.mock.callCount(), 0, 'must not insert a rival row');
  assert.equal(job, before, 'must return the row that already existed');
});

test('requeueStep does NOT start the step while a dependency is unfinished', async (t) => {
  // The exact shape of the bug: analysis triggered right after upload, with
  // every detector still waiting. It ran anyway, consolidated nothing, and hid
  // the pipeline's real row behind a newer `complete` one.
  const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status: 'complete' } });
  mockDb(t, rows);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

  assert.equal(job.status, 'waiting', 'must fall back to waiting, not queued');
  assert.equal(enqueued.length, 0, 'nothing may reach the queue');
});

test('requeueStep starts the step once every dependency is terminal', async (t) => {
  const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status: 'complete' } });
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

  assert.equal(job.status, 'queued');
  assert.equal(enqueued.length, 1);
  assert.ok(job.pgBossJobId, 'the queue id must be recorded on the row');
});

test('requeueStep clears the previous run\'s result before re-running', async (t) => {
  const rows = pipelineRows({
    [JOB_TYPES.PDF_ANALYSIS]: {
      status: 'complete',
      result: { data: { items: [{ resourceName: 'stale' }] } },
      errorMessage: 'a previous failure',
      pgBossJobId: 'old-queue-id'
    }
  });
  mockDb(t, rows);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

  assert.equal(job.result, null, 'a stale result must not survive a re-run');
  assert.equal(job.errorMessage, null,
    'the previous failure text must not survive either — it showed on a job that had just been re-queued');
  assert.equal(job.pgBossJobId, null);
});

test('requeueStep leaves a job that is already running alone', async (t) => {
  for (const status of ['queued', 'processing']) {
    const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status, pgBossJobId: 'in-flight' } });
    completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
    mockDb(t, rows);

    const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

    assert.equal(job.status, status, `${status} must not be disturbed`);
    assert.equal(enqueued.length, 0, `${status} must not be enqueued a second time`);
    t.mock.restoreAll();
  }
});

test('requeueStep creates the row when the round has none', async (t) => {
  const rows = pipelineRows();
  rows.delete(JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

  assert.equal(SubmissionJob.create.mock.callCount(), 1);
  assert.equal(job.jobType, JOB_TYPES.PDF_ANALYSIS);
  assert.equal(job.status, 'waiting', 'a new row waits for its dependencies like any other');
});

test('requeueStep refuses a job type that is not a pipeline step', async (t) => {
  mockDb(t, pipelineRows());
  await assert.rejects(
    () => orchestrator.requeueStep('sub-1', 'not_a_step', 1, 'user-1'),
    /Unknown pipeline step/
  );
});

test('requeueStep respects the KRT gate, not just the dependencies', async (t) => {
  // Dependencies done, but the author is still editing their table: the seeded
  // prompts carry those rows, so starting now seeds from a table about to
  // change.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DATASETS_DETECTION);
  mockDb(t, rows, { id: 'sub-1', status: 'step_krt' });

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-1');

  assert.equal(job.status, 'waiting');
  assert.equal(enqueued.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// checkAndAdvance — the ordinary path a worker takes when it finishes
// ─────────────────────────────────────────────────────────────────────────────

test('finishing conversion starts the steps that were waiting on it', async (t) => {
  const rows = pipelineRows({
    [JOB_TYPES.MARKDOWN_CONVERT]: { status: 'complete', result: { data: { markdownLength: 5000 } } }
  });
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-1');

  const started = [...rows.values()].filter((r) => r.status === 'queued').map((r) => r.jobType);
  assert.ok(started.includes(JOB_TYPES.DATASETS_DETECTION), 'detectors must start');
  assert.ok(started.includes(JOB_TYPES.SOFTWARE_DETECTION));
  assert.ok(!started.includes(JOB_TYPES.PDF_ANALYSIS), 'the consolidator still waits on the detectors');
});

test('an empty conversion starts nothing that reads the manuscript', async (t) => {
  // Conversion is fail-soft: it completes with zero characters. Every detector
  // then reported zero findings, which reads as "your manuscript mentions
  // none of this" rather than "we never read it".
  const rows = pipelineRows({
    [JOB_TYPES.MARKDOWN_CONVERT]: { status: 'complete', result: { data: { markdownLength: 0 } } }
  });
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-1');

  assert.equal(enqueued.length, 0);
  assert.ok([...rows.values()].every((r) => r.status !== 'queued'));
});

test('a step whose dependency FAILED waits for a person', async (t) => {
  // This used to advance: `failed` counted as terminal alongside `complete`, so
  // the consolidator ran and built a Generated KRT from four detectors instead
  // of five — with nothing anywhere saying so. A quietly thinner answer is worse
  // than a visible stall, because the reader cannot tell it happened.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.DATASETS_DETECTION).result = null;
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'waiting');
  assert.equal(enqueued.length, 0, 'and nothing is spent while it waits');
});

test('acknowledging the failure lets the rest of the pipeline through', async (t) => {
  // The other half of the choice: carry on without that step's data. Recorded on
  // the row, so the run history can answer "who decided this report would be
  // built without datasets detection".
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  const failed = rows.get(JOB_TYPES.DATASETS_DETECTION);
  failed.status = 'failed';
  failed.result = null;
  failed.decision = { at: '2026-08-22T12:00:00Z', byUserId: 'user-1' };
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
});

test('one unacknowledged failure is enough to hold a step', async (t) => {
  // Two detectors failed and only one was waved through. The consolidator still
  // waits — a decision about datasets says nothing about materials.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  Object.assign(rows.get(JOB_TYPES.DATASETS_DETECTION), {
    status: 'failed', result: null, decision: { at: new Date().toISOString(), byUserId: 'user-1' }
  });
  Object.assign(rows.get(JOB_TYPES.MATERIALS_DETECTION), { status: 'failed', result: null });
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'waiting');
});

test('a cancelled dependency cancels the step rather than leaving it waiting', async (t) => {
  // A job stuck in `waiting` forever keeps "all processes finished" false and
  // blocks the Continue button downstream.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'cancelled';
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'cancelled');
  assert.equal(enqueued.length, 0);
});

test('advancing is idempotent: a step already complete is not re-run', async (t) => {
  const rows = pipelineRows({
    [JOB_TYPES.MARKDOWN_CONVERT]: { status: 'complete', result: { data: { markdownLength: 5000 } } },
    [JOB_TYPES.DATASETS_DETECTION]: { status: 'complete' }
  });
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-1');

  assert.ok(!enqueued.includes(jobQueue.QUEUES.DATASETS_DETECTION));
  assert.equal(rows.get(JOB_TYPES.DATASETS_DETECTION).status, 'complete');
});

// ─────────────────────────────────────────────────────────────────────────────
// reconcileSubmission — the safety net that recovers a dropped advancement
// ─────────────────────────────────────────────────────────────────────────────

test('the reconciler starts every runnable step and reports how many', async (t) => {
  const rows = pipelineRows({
    [JOB_TYPES.MARKDOWN_CONVERT]: { status: 'complete', result: { data: { markdownLength: 5000 } } }
  });
  mockDb(t, rows);

  const advanced = await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(advanced, enqueued.length);
  assert.ok(advanced > 0, 'the detectors were runnable and must have been started');
});

test('the reconciler changes nothing when the pipeline is already correct', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  mockDb(t, rows);

  assert.equal(await orchestrator.reconcileSubmission('sub-1', 1, 'user-1'), 0);
  assert.equal(enqueued.length, 0);
});

test('a dependency being retried is not treated as finished', async (t) => {
  // The bug this pins: workers wrote `failed` on non-final attempts too, and
  // `failed` is terminal to the orchestrator. A sweep landing inside the retry
  // backoff read DAS extraction as finished, evaluated its dependent's gate
  // against a result that was not there yet, and parked it in `pending_input` —
  // which nothing revisits. When the retry then succeeded, the advance found
  // the dependent no longer `waiting` and did nothing. Only a manual advance
  // recovered it.
  //
  // A retrying job now stays `processing`, so the dependents stay `waiting`.
  const rows = pipelineRows();
  // Everything the Availability check needs is done — except DAS extraction,
  // which is between attempts and has no result yet.
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  rows.get(JOB_TYPES.DAS_EXTRACTION).status = 'processing';
  rows.get(JOB_TYPES.DAS_EXTRACTION).result = null;
  rows.get(JOB_TYPES.DAS_EXTRACTION).errorMessage = 'Gemini 503 — retrying';
  mockDb(t, rows, {
    id: 'sub-1', status: 'step_as', dataAvailabilityStatement: A_STATEMENT, dasConfirmedAt: null
  });

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'waiting',
    'the check must wait for the retry, not be parked awaiting input');
});

test('a dependency that has genuinely failed holds its dependents until acknowledged', async (t) => {
  // The other half of the retry rule. A retrying job stays `processing` and the
  // dependent waits for the retry; a job that has genuinely failed also makes it
  // wait — but for a PERSON, not for the queue. Once the failure is
  // acknowledged the dependent proceeds, and DAS Suggestions then parks in
  // `pending_input` asking the author to confirm the statement, which is the
  // designed path.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  const extraction = rows.get(JOB_TYPES.DAS_EXTRACTION);
  extraction.status = 'failed';
  extraction.result = null;
  mockDb(t, rows, {
    id: 'sub-1', status: 'step_as', dataAvailabilityStatement: A_STATEMENT, dasConfirmedAt: null
  });

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');
  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'waiting',
    'held for a decision, not run against a statement extraction never produced');

  extraction.decision = { at: new Date().toISOString(), byUserId: 'user-1' };
  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'pending_input',
    'and once the decision is made it moves, rather than waiting for ever');
});

// ─────────────────────────────────────────────────────────────────────────────
// onManualRestart — a step clearing what its last run produced
// ─────────────────────────────────────────────────────────────────────────────

test('re-running DAS extraction by hand clears the statement it will replace', async (t) => {
  // Otherwise the button appears to do nothing. The working statement is only
  // filled while it is empty — that is what stops extraction overwriting the
  // author — so a re-extraction on a submission that already has one would
  // write to the extracted field alone and leave the page unchanged.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_EXTRACTION);
  rows.get(JOB_TYPES.DAS_EXTRACTION).status = 'complete';
  const saves = [];
  const submission = {
    id: 'sub-1',
    status: 'step_as',
    dataAvailabilityStatement: 'Data are at Zenodo.',
    dasConfirmedAt: new Date('2026-08-20T09:00:00Z'),
    dasConfirmedByUserId: 'user-1',
    save: async () => { saves.push(true); }
  };
  mockDb(t, rows, submission);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.DAS_EXTRACTION, 1, 'user-2');

  assert.equal(submission.dataAvailabilityStatement, null, 'room is made for the new reading');
  assert.equal(submission.dasConfirmedAt, null, 'and there is nothing left to have confirmed');
  assert.equal(submission.dasConfirmedByUserId, null);
  assert.equal(saves.length, 1, 'the reset has to be persisted, not just held in memory');

  // And it has to say what it destroyed. A user who typed that statement and
  // pressed "re-run" has just lost it; the log is the only place that says so.
  assert.equal(applied.length, 1);
  assert.equal(applied[0].oldValue, 'Data are at Zenodo.');
  assert.equal(applied[0].newValue, null);
  assert.equal(applied[0].userId, 'user-2', 'credited to whoever asked for the re-run');
});

test('the pipeline running extraction on its own does NOT clear it', async (t) => {
  // A normal round must not wipe a statement somebody has already dealt with.
  // Only somebody asking for a fresh reading gets one.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_EXTRACTION);
  const submission = {
    id: 'sub-1',
    status: 'step_as',
    dataAvailabilityStatement: 'Data are at Zenodo.',
    dasConfirmedAt: new Date('2026-08-20T09:00:00Z'),
    dasConfirmedByUserId: 'user-1',
    save: async () => {}
  };
  mockDb(t, rows, submission);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-2');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo.');
  assert.equal(submission.dasConfirmedByUserId, 'user-1');
});

test('re-running a step with no reset hook leaves the submission alone', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.MATERIALS_DETECTION);
  const submission = {
    id: 'sub-1',
    status: 'step_as',
    dataAvailabilityStatement: 'Data are at Zenodo.',
    dasConfirmedAt: new Date('2026-08-20T09:00:00Z'),
    save: async () => { throw new Error('nothing should be saved'); }
  };
  mockDb(t, rows, submission);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1, 'user-2');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo.');
});

test('a reset that throws does not stop the run the user asked for', async (t) => {
  // The run is the request; the reset is housekeeping around it. Refusing to
  // run because the tidy-up failed would be the wrong trade.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_EXTRACTION);
  const submission = {
    id: 'sub-1',
    status: 'step_as',
    dataAvailabilityStatement: 'Data are at Zenodo.',
    save: async () => { throw new Error('database is down'); }
  };
  mockDb(t, rows, submission);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.DAS_EXTRACTION, 1, 'user-2');

  assert.equal(job.status, 'queued');
});

// ─────────────────────────────────────────────────────────────────────────────
// restartSteps — several steps as ONE restart
//
// A loop over requeueStep is not the same thing, and the difference costs money.
// Restart the software detector: everything downstream is reset, and software
// runs. If it finishes before the SECOND restart is issued, grounding finds
// every dependency terminal — materials is still `complete` from the previous
// round — and starts. The second restart then resets it, so grounding runs twice
// and both runs are paid for. The first is invisible rather than harmless,
// because the second answer is the one that sticks.
//
// So: reset every selected step's downstream FIRST, then enqueue.
// ─────────────────────────────────────────────────────────────────────────────

const TWO_DETECTORS = [JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.MATERIALS_DETECTION];

/**
 * Every row complete, as after a finished round, with the seams a batch restart
 * touches: `findOne` and a transaction, both used by cascadeRestart.
 */
function finishedRound(t, submission = { id: 'sub-1', status: 'step_as' }) {
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  // The detectors are gated on there being converted text; without a length the
  // gate holds them at `waiting` and the restart looks like it did nothing.
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 64925 } };
  mockDb(t, rows, submission);
  t.mock.method(SubmissionJob, 'findOne', async ({ where }) => rows.get(where.jobType) || null);
  t.mock.method(require('../../models').sequelize, 'transaction',
    async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));
  return rows;
}

test('nothing is enqueued until every downstream step has been reset', async (t) => {
  // Asserted on the CONSEQUENCE rather than the call order: at the moment the
  // first job is enqueued, grounding must already be `waiting`. If it were
  // still `complete`, a detector finishing could release it into a run the next
  // reset would throw away.
  const rows = finishedRound(t);

  const groundingAtEnqueue = [];
  t.mock.method(jobQueue, 'addJob', async (queueName) => {
    groundingAtEnqueue.push([queueName, rows.get(JOB_TYPES.KRT_GROUNDING).status]);
    return 'pgboss-1';
  });

  await orchestrator.restartSteps('sub-1', TWO_DETECTORS, 1, 'user-1');

  assert.ok(groundingAtEnqueue.length > 0, 'something must have been enqueued');
  for (const [queueName, groundingStatus] of groundingAtEnqueue) {
    assert.notEqual(groundingStatus, 'complete',
      `grounding was still complete when ${queueName} was enqueued`);
  }
});

test('both selected steps are queued, and the shared downstream waits once', async (t) => {
  const rows = finishedRound(t);

  const { restarted, reset } = await orchestrator.restartSteps('sub-1', TWO_DETECTORS, 1, 'user-1');

  assert.deepEqual(restarted, TWO_DETECTORS);
  for (const jobType of TWO_DETECTORS) {
    assert.equal(rows.get(jobType).status, 'queued', `${jobType} runs again`);
  }
  assert.equal(rows.get(JOB_TYPES.KRT_GROUNDING).status, 'waiting',
    'it depends on both, so it waits for both — one run, not two');
  assert.ok(reset.includes(JOB_TYPES.KRT_GROUNDING));
});

test('a detector NOT selected keeps its result', async (t) => {
  // The point of choosing: re-running two detectors must not throw away the
  // other three, which is what "restart from here" on their shared consumer
  // would have done.
  const rows = finishedRound(t);

  await orchestrator.restartSteps('sub-1', TWO_DETECTORS, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PROTOCOLS_DETECTION).status, 'complete');
  assert.equal(rows.get(JOB_TYPES.DATASETS_DETECTION).status, 'complete');
});

test('a step named twice runs once', async (t) => {
  // A UI can send a duplicate; paying for the model twice should not be the
  // consequence.
  const rows = finishedRound(t);

  const { restarted } = await orchestrator.restartSteps(
    'sub-1', [JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.SOFTWARE_DETECTION], 1, 'user-1'
  );

  assert.deepEqual(restarted, [JOB_TYPES.SOFTWARE_DETECTION]);
  assert.equal(enqueued.filter((q) => q === jobQueue.QUEUES.SOFTWARE_DETECTION).length, 1);
});

test('a selected step is not also reported as debris', async (t) => {
  // Grounding is downstream of the detectors. Selecting it too must not put it
  // in `reset` as well as `restarted` — two categories that mean opposite
  // things.
  const rows = finishedRound(t);

  const { restarted, reset } = await orchestrator.restartSteps(
    'sub-1', [...TWO_DETECTORS, JOB_TYPES.KRT_GROUNDING], 1, 'user-1'
  );

  assert.ok(restarted.includes(JOB_TYPES.KRT_GROUNDING));
  assert.ok(!reset.includes(JOB_TYPES.KRT_GROUNDING));
});

test('every run it starts is credited to whoever asked', async (t) => {
  const rows = finishedRound(t);

  await orchestrator.restartSteps('sub-1', TWO_DETECTORS, 1, 'user-7');

  for (const jobType of TWO_DETECTORS) {
    assert.equal(rows.get(jobType).triggeredByUserId, 'user-7');
  }
});

test('an unknown step is refused, and nothing is touched', async (t) => {
  // Half a restart is worse than none: the caller would have to work out which
  // half ran.
  const rows = finishedRound(t);

  await assert.rejects(
    () => orchestrator.restartSteps('sub-1', [JOB_TYPES.SOFTWARE_DETECTION, 'not_a_step'], 1, 'user-1'),
    /Unknown pipeline step/
  );
  assert.equal(rows.get(JOB_TYPES.SOFTWARE_DETECTION).status, 'complete');
  assert.equal(enqueued.length, 0);
});

test('an empty selection is refused', async (t) => {
  const rows = finishedRound(t);

  await assert.rejects(() => orchestrator.restartSteps('sub-1', [], 1, 'user-1'), /No steps/);
  assert.equal(enqueued.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// One act, one pipeline run
//
// Every entry point is the same operation with a different set of steps to
// re-execute, and each one is ONE attempt. Getting the count wrong is not
// cosmetic: a run superseded before anything in it executed is a record of an
// attempt that never happened, and the history then shows three restarts where
// the user pressed one button.
//
// The run must also exist BEFORE anything is enqueued — an execution files
// itself under the round's current run, so a step enqueued first is recorded
// against the run this one replaces.
// ─────────────────────────────────────────────────────────────────────────────

test('a batch restart is one run, not one per step', async (t) => {
  finishedRound(t);

  await orchestrator.restartSteps('sub-1', TWO_DETECTORS, 1, 'user-1');

  assert.equal(pipelineRuns.created.length, 1);
  assert.equal(pipelineRuns.created[0].cause, 'restart');
  assert.deepEqual(pipelineRuns.created[0].reRun, TWO_DETECTORS);
  assert.equal(pipelineRuns.created[0].userId, 'user-1');
});

test('a retry is a run of its own, named as a retry', async (t) => {
  const rows = pipelineRows({
    [JOB_TYPES.MARKDOWN_CONVERT]: { status: 'failed', decision: null }
  });
  mockDb(t, rows);

  await orchestrator.retryStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-2');

  assert.equal(pipelineRuns.created.length, 1);
  assert.equal(pipelineRuns.created[0].cause, 'retry');
  assert.deepEqual(pipelineRuns.created[0].reRun, [JOB_TYPES.MARKDOWN_CONVERT]);
});

test('re-running one step by hand opens one run', async (t) => {
  const rows = finishedRound(t);
  completeUpstreamOf(rows, JOB_TYPES.SOFTWARE_DETECTION);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.SOFTWARE_DETECTION, 1, 'user-3');

  assert.equal(pipelineRuns.created.length, 1);
  assert.equal(pipelineRuns.created[0].cause, 'restart');
});

test('starting the round opens a run before a single step is enqueued', async (t) => {
  const rows = pipelineRows();
  mockDb(t, rows);
  // Recorded at the moment of the call: an execution resolves the round's
  // CURRENT run, so ordering is the whole property here.
  let runsWhenFirstEnqueued = null;
  t.mock.method(jobQueue, 'addJob', async (queueName) => {
    if (runsWhenFirstEnqueued === null) runsWhenFirstEnqueued = pipelineRuns.created.length;
    enqueued.push(queueName);
    return 'pgboss-1';
  });

  await orchestrator.runAllProcesses('sub-1', 'user-4', 1);

  assert.equal(runsWhenFirstEnqueued, 1, 'the run must exist before anything is queued');
  assert.equal(pipelineRuns.created.length, 1);
  assert.equal(pipelineRuns.created[0].reRun, 'all');
});

test('a replaced manuscript says so, rather than passing as a restart', async (t) => {
  mockDb(t, pipelineRows());

  await orchestrator.runAllProcesses('sub-1', 'user-5', 1, { cause: 'new_document' });

  assert.equal(pipelineRuns.created[0].cause, 'new_document');
});

test('re-queueing a step that is already running opens no run at all', async (t) => {
  const rows = pipelineRows({ [JOB_TYPES.SOFTWARE_DETECTION]: { status: 'processing' } });
  mockDb(t, rows);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.SOFTWARE_DETECTION, 1, 'user-6');

  // Nothing re-executes, so there is no attempt to record — and a run opened
  // here would supersede the live one while its steps carried on writing to it.
  assert.equal(pipelineRuns.created.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// retryStep — unblocking one failure, changing nothing else
//
// After an external service is fixed, what is wanted is to unblock the pipeline,
// not to re-run the round. The condition that makes that legitimate is not "did
// it fail" but "has anything consumed the failure yet": while everything
// downstream is still `waiting`, nothing was built on its absence, so running it
// alone leaves nothing stale.
// ─────────────────────────────────────────────────────────────────────────────

test('a failure nothing has run past is retryable', async (t) => {
  // Markdown Convert failed and every detector is behind the markdown gate.
  // This is the case a blocked pipeline is in.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).status = 'failed';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  const { retryable } = orchestrator.describeRetry(JOB_TYPES.MARKDOWN_CONVERT, rows);

  assert.equal(retryable, true);
});

test('a failure something HAS run past is not', async (t) => {
  // Retrying alone would leave grounding's result built on the failure while
  // this step's is not. That needs a restart, which resets it too.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.SOFTWARE_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.KRT_GROUNDING).status = 'complete';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  const { retryable, reason } = orchestrator.describeRetry(JOB_TYPES.SOFTWARE_DETECTION, rows);

  assert.equal(retryable, false);
  assert.equal(reason, 'downstream_already_ran');
});

test('a step with no downstream is retryable — there is nothing to leave stale', async (t) => {
  const rows = pipelineRows();
  rows.get(JOB_TYPES.SUGGESTION_GENERATION).status = 'failed';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  assert.equal(orchestrator.describeRetry(JOB_TYPES.SUGGESTION_GENERATION, rows).retryable, true);
});

test('a step with no issue is not retryable', async (t) => {
  // A clean run: "do it again" is a restart, and it is offered where restarts
  // are. Retry is for putting an issue right.
  const rows = pipelineRows();
  Object.assign(rows.get(JOB_TYPES.SOFTWARE_DETECTION), {
    status: 'complete',
    result: { service: { outcome: { state: 'done' } } }
  });
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  assert.equal(orchestrator.describeRetry(JOB_TYPES.SOFTWARE_DETECTION, rows).reason, 'no_issue');
});

test('a PARTIAL is retryable — and now, cheaply', async (t) => {
  // Before issues paused, retrying a partial meant re-running everything that
  // had already consumed it. Now nothing downstream has run yet, so it is as
  // cheap as retrying a failure.
  const rows = pipelineRows();
  Object.assign(rows.get(JOB_TYPES.SOFTWARE_DETECTION), {
    status: 'complete',
    result: { service: { outcome: { state: 'partial', failReason: 'lm_failed' } } }
  });
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  assert.equal(orchestrator.describeRetry(JOB_TYPES.SOFTWARE_DETECTION, rows).retryable, true);
});

test('a cancelled downstream step blocks a retry', async (t) => {
  // Cancelled is run-and-stopped, not never-run. Retrying past it would leave a
  // cancelled step sitting behind a running one, which nothing revisits.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.SOFTWARE_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.KRT_GROUNDING).status = 'cancelled';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  assert.equal(orchestrator.describeRetry(JOB_TYPES.SOFTWARE_DETECTION, rows).retryable, false);
});

test('retrying resets the row and runs it', async (t) => {
  const rows = pipelineRows();
  const job = rows.get(JOB_TYPES.MARKDOWN_CONVERT);
  Object.assign(job, {
    status: 'failed',
    errorMessage: 'Converter 503',
    result: { status: { detected: false } },
    retryCount: 3,
    pgBossJobId: 'old-job'
  });
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await orchestrator.retryStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-3');

  assert.equal(job.status, 'queued');
  assert.equal(job.errorMessage, null, 'the previous failure must not show against the new run');
  assert.equal(job.result, null);
  assert.equal(job.retryCount, 0, 'the attempts belonged to the run that failed');
  assert.equal(job.triggeredByUserId, 'user-3');
});

test('a retry does NOT release the round\'s input freezes', async (t) => {
  // The round is mid-flight and the steps that did run read the frozen
  // documents. A retry taking fresh ones would split the round — the failure the
  // freeze exists to prevent, arriving through the repair path.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).status = 'failed';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });
  const released = [];
  t.mock.method(require('./input-freeze.service'), 'releaseForRestart', async (...args) => {
    released.push(args);
    return [];
  });

  await orchestrator.retryStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-3');

  assert.deepEqual(released, []);
});

test('a retry does not reset anything downstream', async (t) => {
  // There is nothing to reset — that is the precondition — and touching a
  // downstream row would make a retry a restart wearing a smaller name.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).status = 'failed';
  rows.get(JOB_TYPES.ORCID_EXTRACTION).status = 'complete';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await orchestrator.retryStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-3');

  assert.equal(rows.get(JOB_TYPES.ORCID_EXTRACTION).status, 'complete',
    'an unrelated finished step is left alone');
});

test('retrying DAS extraction keeps the statement', async (t) => {
  // `onManualRestart` clears it, because asking for a fresh reading is what a
  // RESTART means. A retry after the service came back must not throw away a
  // statement the author typed while it was down.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.DAS_EXTRACTION).status = 'failed';
  const submission = {
    id: 'sub-1',
    status: 'step_as',
    dataAvailabilityStatement: 'All data are in the supplement.',
    dasConfirmedAt: new Date('2026-08-20T09:00:00Z'),
    save: async () => {}
  };
  mockDb(t, rows, submission);

  await orchestrator.retryStep('sub-1', JOB_TYPES.DAS_EXTRACTION, 1, 'user-3');

  assert.equal(submission.dataAvailabilityStatement, 'All data are in the supplement.');
  assert.ok(submission.dasConfirmedAt, 'and its confirmation');
});

test('a refused retry says what to do instead', async (t) => {
  // "Cannot retry" with no way forward is a dead end; the restart that WOULD
  // work is on another page and the user has to be told which.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.SOFTWARE_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.KRT_GROUNDING).status = 'complete';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await assert.rejects(
    () => orchestrator.retryStep('sub-1', JOB_TYPES.SOFTWARE_DETECTION, 1, 'user-3'),
    /Restart it from the pipeline page/
  );
  assert.equal(rows.get(JOB_TYPES.SOFTWARE_DETECTION).status, 'failed', 'and changes nothing');
});

test('an unknown step is refused', async (t) => {
  const rows = pipelineRows();
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await assert.rejects(
    () => orchestrator.retryStep('sub-1', 'not_a_step', 1, 'user-3'),
    /Unknown pipeline step/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// acknowledgeIssue — carrying on without a step's data
//
// The second answer a paused pipeline asks for. It re-runs nothing and does not
// pretend the step succeeded: the row stays `failed`, and what is recorded is
// that a person decided the rest should proceed without it. Recorded, because a
// report built without software detection looks exactly like one where software
// detection found nothing.
// ─────────────────────────────────────────────────────────────────────────────

test('the decision is recorded with who made it and when', async (t) => {
  const rows = pipelineRows();
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'failed';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await orchestrator.acknowledgeIssue('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-5');

  // On the EXECUTION, not the job row. That is what makes the decision travel
  // with the result it is about — and what removes the field three call sites
  // had to remember to clear on a re-run.
  const decision = pipelineRuns.executions[JOB_TYPES.DATASETS_DETECTION].decision;
  assert.ok(decision.at);
  assert.equal(decision.byUserId, 'user-5');
  assert.equal(decision.choice, 'continue');
});

test('the step stays failed — this is not a pretend success', async (t) => {
  const rows = pipelineRows();
  const failed = rows.get(JOB_TYPES.DATASETS_DETECTION);
  failed.status = 'failed';
  failed.errorMessage = 'Gemini 503';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await orchestrator.acknowledgeIssue('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-5');

  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorMessage, 'Gemini 503', 'and it still says why');
});

test('it releases what was held behind it', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.DATASETS_DETECTION).result = null;
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'waiting', 'precondition');

  await orchestrator.acknowledgeIssue('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-5');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
});

test('a step that finished cleanly cannot be carried past', async (t) => {
  // There is nothing to decide about, and recording a decision would put a
  // skip-marker on a step that ran perfectly well.
  const rows = pipelineRows();
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'complete';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await assert.rejects(
    () => orchestrator.acknowledgeIssue('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-5'),
    /nothing to decide about/
  );
});

test('a PARTIAL can be carried past — same decision, same record', async (t) => {
  // The module produced a real answer with one of its engines dead. That is a
  // decision, not a failure, and it is logged the same way: "this report was
  // built with software detection missing its Softcite half, and a person chose
  // that" is unanswerable otherwise.
  const rows = pipelineRows();
  const partial = rows.get(JOB_TYPES.PROTOCOLS_DETECTION);
  partial.status = 'complete';
  partial.result = { service: { outcome: { state: 'partial', failReason: 'lm_failed' } } };
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  const job = await orchestrator.acknowledgeIssue('sub-1', JOB_TYPES.PROTOCOLS_DETECTION, 1, 'user-5');

  const decision = pipelineRuns.executions[JOB_TYPES.PROTOCOLS_DETECTION].decision;
  assert.ok(decision.at);
  assert.equal(decision.byUserId, 'user-5');
  assert.equal(job.status, 'complete', 'it completed — that does not change');
});

test('deciding twice is not an error, and does not rewrite who decided', async (t) => {
  // Two people looking at the same stalled pipeline both press Continue. The
  // second must not overwrite the first's name on the record.
  const rows = pipelineRows();
  const failed = rows.get(JOB_TYPES.DATASETS_DETECTION);
  failed.status = 'failed';
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });
  // On the EXECUTION, which is where the guard looks. The job row's copy is
  // hydrated from it and would be the wrong thing to seed.
  const first = { at: '2026-08-22T09:00:00Z', byUserId: 'user-first', choice: 'continue' };
  pipelineRuns.decide(JOB_TYPES.DATASETS_DETECTION, first);

  await orchestrator.acknowledgeIssue('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-9');

  assert.deepEqual(pipelineRuns.executions[JOB_TYPES.DATASETS_DETECTION].decision, first);
});

test('a retried step is not still carrying the decision about its failure', async (t) => {
  // The decision was about a failure this run is replacing. It used to be two
  // columns on the job row, cleared in three places — and `runAllProcesses`,
  // the one that re-runs everything, did not clear them, so a decision about
  // run 1's failure silently waved run 2's through.
  //
  // There is nothing to clear now. A retry opens a run that RE-EXECUTES this
  // step, so the execution the round holds for it is a new one, and a new
  // execution has never been decided about. The bug is not fixed here; it is
  // unrepresentable.
  const rows = pipelineRows();
  const failed = rows.get(JOB_TYPES.MARKDOWN_CONVERT);
  Object.assign(failed, {
    status: 'failed',
    decision: { at: '2026-08-22T09:00:00Z', byUserId: 'user-1' }
  });
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await orchestrator.retryStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-5');

  // The run that was opened re-executes the step, which is what guarantees a
  // fresh execution.
  assert.equal(pipelineRuns.created.length, 1);
  assert.deepEqual(pipelineRuns.created[0].reRun, [JOB_TYPES.MARKDOWN_CONVERT]);
  assert.equal(pipelineRuns.created[0].cause, 'retry');
});

test('which failures are holding a step is reported by name', async (t) => {
  // "Waiting" tells a user nothing; "waiting because Datasets Detection failed"
  // tells them where to go.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.MATERIALS_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.MATERIALS_DETECTION).decision = { at: new Date().toISOString(), byUserId: 'u' };

  const blocking = orchestrator.blockingIssues(JOB_TYPES.PDF_ANALYSIS, rows);

  assert.deepEqual(blocking, [JOB_TYPES.DATASETS_DETECTION],
    'only the one still undecided');
});

// ─────────────────────────────────────────────────────────────────────────────
// The four cases a finished step can be in
//
//   1. no error, results        → clean, carry on
//   2. no error, nothing found  → clean. A detector finding nothing IS an answer
//   3. partial error            → a person decides
//   4. total error              → a person decides
//
// 3 and 4 differ only in what is left behind, so one predicate covers both —
// and it also swallows what used to slip through: a step reaching `complete`
// while its outcome was `fail`, which a rule keyed on status alone let past.
// ─────────────────────────────────────────────────────────────────────────────

const withOutcome = (state, extra = {}) => ({
  jobType: JOB_TYPES.DATASETS_DETECTION,
  status: 'complete',
  result: { service: { outcome: { state, ...extra } }, data: { items: [] } }
});

test('case 1 — a clean run with results needs nobody', () => {
  assert.equal(orchestrator.issueOf(withOutcome('done')).needed, false);
});

test('case 2 — a detector that found nothing is an ANSWER, not an issue', () => {
  // The distinction the whole thing turns on. "No datasets in this manuscript"
  // is a result, and stopping the round to ask about it would make the pipeline
  // unusable on half the papers it sees.
  const empty = withOutcome('done');
  empty.result.data.items = [];

  assert.equal(orchestrator.issueOf(empty).needed, false);
  assert.equal(orchestrator.producedOutput(empty), true, 'it produced an answer');
});

test('case 3 — a partial asks', () => {
  const { needed, kind } = orchestrator.issueOf(withOutcome('partial', { failReason: 'lm_failed' }));

  assert.equal(needed, true);
  assert.equal(kind, 'partial');
});

test('case 4 — a total error asks', () => {
  const failed = { jobType: JOB_TYPES.DATASETS_DETECTION, status: 'failed', result: null };

  assert.equal(orchestrator.issueOf(failed).kind, 'failure');
});

test('and so does a run that COMPLETED while producing nothing usable', () => {
  // The hole the old rule left: status `complete`, outcome `fail`. Nothing
  // paused, and the consolidator built on it.
  const { needed, kind } = orchestrator.issueOf(
    withOutcome('fail', { failReason: 'external_failed_demo_disabled' })
  );

  assert.equal(needed, true);
  assert.equal(kind, 'unusable');
});

test('a tolerated engine does not ask', () => {
  // Softcite dying leaves the LM pass, which read the manuscript. It happens
  // often and stopping the round for it would be noise — so it is declared,
  // per module and per engine, rather than inferred.
  const partial = {
    jobType: JOB_TYPES.SOFTWARE_DETECTION,
    status: 'complete',
    result: { service: { outcome: { state: 'partial', failReason: 'softcite_failed' } } }
  };

  assert.equal(orchestrator.issueOf(partial).needed, false);
});

test('but the same module asks when the OTHER engine dies', () => {
  // The LM dying leaves name-matching with no reading behind it — a different
  // kind of incomplete, and worth a question.
  const partial = {
    jobType: JOB_TYPES.SOFTWARE_DETECTION,
    status: 'complete',
    result: { service: { outcome: { state: 'partial', failReason: 'lm_failed' } } }
  };

  assert.equal(orchestrator.issueOf(partial).kind, 'partial');
});

test('a partial holds the steps that come after it', async (t) => {
  // The change from before: a partial used to sail through, and the
  // consolidator ran on an answer missing half its engine.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  Object.assign(rows.get(JOB_TYPES.MATERIALS_DETECTION), {
    status: 'complete',
    result: { service: { outcome: { state: 'partial', failReason: 'lm_failed' } } }
  });
  mockDb(t, rows, { id: 'sub-1', status: 'step_as' });

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'waiting');
});

// ─────────────────────────────────────────────────────────────────────────────
// Skipping — what "continue" means when the missing data was REQUIRED
// ─────────────────────────────────────────────────────────────────────────────

test('a step whose required input produced nothing is SKIPPED, not run', () => {
  // Running it would fail, and so would everything after it: nine unexplained
  // failures in place of the one real one.
  const detector = orchestrator.PIPELINE.find((s) => s.jobType === JOB_TYPES.DATASETS_DETECTION);

  assert.ok(!(detector.optional || []).includes(JOB_TYPES.MARKDOWN_CONVERT));
});

test('but a step whose OPTIONAL input is missing still runs', () => {
  // The consolidator unions what it is given and carries every author row
  // through regardless, so a dead detector costs it coverage, not the ability
  // to run.
  const analysis = orchestrator.PIPELINE.find((s) => s.jobType === JOB_TYPES.PDF_ANALYSIS);

  for (const detector of [JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.KRT_GROUNDING]) {
    assert.ok(analysis.optional.includes(detector), `${detector} is optional to the consolidator`);
  }
});

test('the issue list says what continuing would cost', () => {
  // The difference between "these will run with less" and "these cannot run at
  // all" is the whole reason Continue is not a gamble.
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'waiting';
  rows.set(JOB_TYPES.MARKDOWN_CONVERT, {
    jobType: JOB_TYPES.MARKDOWN_CONVERT, status: 'complete',
    result: { data: { markdownLength: 0 } }
  });

  const [issue] = orchestrator.describeIssues(rows);

  assert.equal(issue.jobType, JOB_TYPES.MARKDOWN_CONVERT);
  assert.equal(issue.kind, 'unusable');
  assert.ok(issue.wouldSkip.includes(JOB_TYPES.DATASETS_DETECTION),
    'the detectors cannot run without text');
  assert.ok(!issue.wouldSkip.includes(JOB_TYPES.PDF_ANALYSIS),
    'the consolidator can — every one of its dependencies is optional');
});

test('a decided issue is still listed, but no longer blocking', () => {
  // It stays in the record — "software detection was carried past, by Nicolas,
  // on the 22nd" is the thing the report needs — while ceasing to hold anything.
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  // Conversion needs a length or it is an issue in its own right — which is the
  // rule working, and would put a second entry in this list.
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 64925 } };
  Object.assign(rows.get(JOB_TYPES.DATASETS_DETECTION), {
    status: 'failed',
    decision: { at: '2026-08-22T12:00:00Z', byUserId: 'user-5' }
  });

  const issues = orchestrator.describeIssues(rows);
  assert.equal(issues.length, 1, 'only the one that was decided about');
  const [issue] = issues;

  assert.equal(issue.blocking, false);
  assert.equal(issue.decided.byUserId, 'user-5');
});

test('a clean pipeline has no issues at all', () => {
  const rows = pipelineRows();
  for (const r of rows.values()) {
    r.status = 'complete';
    r.result = { service: { outcome: { state: 'done' } } };
  }
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = {
    service: { outcome: { state: 'done' } }, data: { markdownLength: 64925 }
  };

  assert.deepEqual(orchestrator.describeIssues(rows), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// cascadeRestart — invalidating what a re-run makes stale
// ─────────────────────────────────────────────────────────────────────────────

test('a cascaded reset drops the previous run\'s error and result', async (t) => {
  // Found live: re-running grounding reset suggestion_generation from `failed`
  // to `waiting`, and the panel kept showing its Gemini 503 against a job that
  // was about to run again. requeueStep had already been fixed for exactly this
  // complaint; cascadeRestart, one function along, had not.
  const rows = pipelineRows({
    [JOB_TYPES.SUGGESTION_GENERATION]: {
      status: 'failed',
      errorMessage: 'Gemini error: 503 UNAVAILABLE',
      result: { data: { suggestions: [1, 2, 3] } }
    }
  });
  mockDb(t, rows);
  t.mock.method(SubmissionJob, 'findOne', async ({ where }) => rows.get(where.jobType) || null);
  t.mock.method(require('../../models').sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));

  await orchestrator.cascadeRestart('sub-1', JOB_TYPES.KRT_GROUNDING, 1);

  const sug = rows.get(JOB_TYPES.SUGGESTION_GENERATION);
  assert.equal(sug.status, 'waiting');
  assert.equal(sug.errorMessage, null, 'a failure from the previous run must not be shown against the next one');
  assert.equal(sug.result, null, 'nor its result');
});

test('a cascaded reset leaves in-flight work alone', async (t) => {
  // Resetting a running job would orphan the worker holding it.
  const rows = pipelineRows({
    [JOB_TYPES.SUGGESTION_GENERATION]: { status: 'processing', errorMessage: null }
  });
  mockDb(t, rows);
  t.mock.method(SubmissionJob, 'findOne', async ({ where }) => rows.get(where.jobType) || null);
  t.mock.method(require('../../models').sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }));

  await orchestrator.cascadeRestart('sub-1', JOB_TYPES.KRT_GROUNDING, 1);

  assert.equal(rows.get(JOB_TYPES.SUGGESTION_GENERATION).status, 'processing');
});

// ─────────────────────────────────────────────────────────────────────────────
// requeueStep — one way to re-run a step, for every step
// ─────────────────────────────────────────────────────────────────────────────

test('a re-run reuses the round\'s own row instead of inserting a rival', async (t) => {
  // Inserting was the shape of the bug that shipped a Generated KRT with zero
  // detections: getForSubmission keeps only the NEWEST row per type, so a
  // second row hides the pipeline's own and the advancement that should have
  // followed lands on the wrong one.
  const rows = pipelineRows({
    [JOB_TYPES.MARKDOWN_CONVERT]: { status: 'complete', result: { data: { markdownLength: 5000 } } }
  });
  mockDb(t, rows);
  const before = rows.get(JOB_TYPES.MARKDOWN_CONVERT);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-1');

  assert.equal(job, before, 'the same row, re-used');
  assert.equal(job.status, 'queued');
  assert.equal(job.result, null, 'the previous run\'s result must not survive into the new one');
});

test('a re-run asked for while the step is in flight does not start a second one', async (t) => {
  for (const status of ['queued', 'processing']) {
    const rows = pipelineRows({ [JOB_TYPES.MARKDOWN_CONVERT]: { status } });
    mockDb(t, rows);
    enqueued = [];

    const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.MARKDOWN_CONVERT, 1, 'user-1');

    assert.equal(job.status, status, `a ${status} step must be left alone`);
    assert.equal(enqueued.length, 0, 'nothing may be enqueued beside a run already going');
  }
});

test('a re-run clears the previous failure rather than showing it beside a queued job', async (t) => {
  const rows = pipelineRows({
    [JOB_TYPES.ORCID_EXTRACTION]: { status: 'failed', errorMessage: 'GROBID timed out' }
  });
  mockDb(t, rows);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.ORCID_EXTRACTION, 1, 'user-1');

  assert.equal(job.errorMessage, null);
  assert.equal(job.status, 'queued');
});

// ─────────────────────────────────────────────────────────────────────────────
// advanceJob — the manual "I have entered it, start now" path
// ─────────────────────────────────────────────────────────────────────────────

test('advanceJob starts a job parked awaiting the user\'s input', async (t) => {
  const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status: 'pending_input' } });
  mockDb(t, rows);

  const job = await orchestrator.advanceJob('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

  assert.equal(job.status, 'queued');
  assert.equal(enqueued.length, 1);
});

test('advanceJob is a no-op on a job that has already moved on', async (t) => {
  // The UI fires a redundant advance in normal use (a shared modal closing on a
  // submission whose analysis finished); that must not be a 500.
  for (const status of ['queued', 'processing', 'complete']) {
    const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status } });
    mockDb(t, rows);

    const job = await orchestrator.advanceJob('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1');

    assert.equal(job.status, status);
    assert.equal(enqueued.length, 0);
    t.mock.restoreAll();
  }
});

test('advanceJob refuses a job that is not awaiting input', async (t) => {
  // 'waiting' means the pipeline has not reached it — starting it here would
  // run it before its dependencies, which is the bug this whole file exists for.
  for (const status of ['waiting', 'failed']) {
    const rows = pipelineRows({ [JOB_TYPES.PDF_ANALYSIS]: { status } });
    mockDb(t, rows);

    await assert.rejects(
      () => orchestrator.advanceJob('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1'),
      /not awaiting input/,
      `${status} must not be advanceable`
    );
    t.mock.restoreAll();
  }
});

test('advanceJob reports a missing job as not found', async (t) => {
  const rows = pipelineRows();
  rows.delete(JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);

  await assert.rejects(
    () => orchestrator.advanceJob('sub-1', JOB_TYPES.PDF_ANALYSIS, 1, 'user-1'),
    /not found/i
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The pipeline table itself — invariants a new step must not break
// ─────────────────────────────────────────────────────────────────────────────

test('every dependency names a step that exists', () => {
  const known = new Set(orchestrator.PIPELINE.map((s) => s.jobType));
  for (const step of orchestrator.PIPELINE) {
    for (const dep of step.dependsOn) {
      assert.ok(known.has(dep), `${step.jobType} depends on unknown step "${dep}"`);
    }
  }
});

test('every step is declared exactly once', () => {
  const seen = new Set();
  for (const step of orchestrator.PIPELINE) {
    assert.ok(!seen.has(step.jobType), `${step.jobType} is declared twice`);
    seen.add(step.jobType);
  }
});

test('every step that reads the manuscript waits for the KRT and requires the text', () => {
  // Two conditions, and they are now different KINDS of condition — which is
  // the point of the split. Waiting for the author to finish curating is a fact
  // about the SUBMISSION, so it stays a gate. Needing converted text is a fact
  // about a DEPENDENCY, so it is a required edge, and the "is there any text"
  // question lives once on the conversion rather than five times here.
  const readsManuscript = [
    JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.DATASETS_DETECTION,
    JOB_TYPES.MATERIALS_DETECTION, JOB_TYPES.PROTOCOLS_DETECTION,
    JOB_TYPES.IDENTIFIER_DETECTION
  ];
  for (const jobType of readsManuscript) {
    const step = orchestrator.PIPELINE.find((s) => s.jobType === jobType);

    assert.deepEqual([...step.gate].sort(), ['krt_curated'],
      `${jobType} waits for the author to finish curating`);
    assert.ok(step.dependsOn.includes(JOB_TYPES.MARKDOWN_CONVERT),
      `${jobType} depends on the conversion`);
    assert.ok(!(step.optional || []).includes(JOB_TYPES.MARKDOWN_CONVERT),
      `${jobType} cannot run without the text, so the conversion is required`);
  }
});

test('every step that READS the manuscript depends on the conversion', () => {
  // The invariant that would have caught a live regression: KRT Grounding reads
  // the manuscript but declared no dependency on the conversion — it had been
  // relying on the `markdown_ready` gate. When that moved onto the conversion
  // as `produced`, grounding was left with no protection and started on a round
  // whose text never existed.
  //
  // `reads` and `dependsOn` were two lists that could disagree. Now they cannot.
  for (const step of orchestrator.PIPELINE) {
    if (!(step.reads || []).includes('markdown')) continue;
    if (step.jobType === JOB_TYPES.MARKDOWN_CONVERT) continue;   // it produces it

    assert.ok(step.dependsOn.includes(JOB_TYPES.MARKDOWN_CONVERT),
      `${step.jobType} reads the manuscript, so it must depend on the conversion`);
    assert.ok(!(step.optional || []).includes(JOB_TYPES.MARKDOWN_CONVERT),
      `${step.jobType} cannot read a manuscript that was never produced`);
  }
});

test('every step that READS the KRT can say where it comes from', () => {
  // The same shape of check for the other document. The KRT has no producing
  // STEP — the author uploads it — so this only asserts the declaration exists,
  // which is what the input freeze keys off.
  for (const step of orchestrator.PIPELINE) {
    if (!(step.reads || []).includes('krt')) continue;
    assert.ok(Array.isArray(step.reads), `${step.jobType} declares what it reads`);
  }
});

test('the "is there any text" question is asked once, on the conversion', () => {
  // It used to be a gate function repeated across seven readers. A reader added
  // later without it would have run on an empty document, and nothing would
  // have said so.
  const convert = orchestrator.PIPELINE.find((s) => s.jobType === JOB_TYPES.MARKDOWN_CONVERT);

  assert.equal(typeof convert.produced, 'function');
  assert.equal(convert.produced({ result: { data: { markdownLength: 0 } } }), false);
  assert.equal(convert.produced({ result: { data: { markdownLength: 42 } } }), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// The Availability Statement is NOT an input to the consolidator
// ─────────────────────────────────────────────────────────────────────────────

test('a missing Availability Statement no longer blocks the consolidator', async (t) => {
  // PDF Analysis used to depend on DAS extraction and refuse to advance until a
  // statement existed, parking in `pending_input` until somebody typed one.
  //
  // It was the wrong step to ask. The consolidator merges the KRT detectors'
  // findings; it never reads the statement. So a field that only the
  // Availability step uses was holding up the entire KRT half of the pipeline —
  // and holding it in `pending_input`, which nothing revisits, so a run that
  // parked there needed a manual advance even after the author supplied one.
  //
  // Every shape of "no statement" must now advance it, including the ones that
  // used to be treated as an unfinished result.
  const noStatement = [
    { status: { detected: false } },
    null,
    {},
    { status: {} },
    { status: { detected: 'yes' } }
  ];

  for (const result of noStatement) {
    const rows = pipelineRows();
    completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
    rows.get(JOB_TYPES.DAS_EXTRACTION).result = result;
    mockDb(t, rows, { id: 'sub-1', status: 'step_pdf', dataAvailabilityStatement: null });

    await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.KRT_GROUNDING, 1, 'user-1');

    assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued',
      `result ${JSON.stringify(result)} must not hold up the consolidator`);
    t.mock.restoreAll();
  }
});

test('a failed DAS extraction does not hold up the consolidator either', async (t) => {
  // The strongest form: extraction is not merely empty, it errored. The
  // consolidator still has everything it needs.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DAS_EXTRACTION).status = 'failed';
  rows.get(JOB_TYPES.DAS_EXTRACTION).result = null;
  mockDb(t, rows, { id: 'sub-1', status: 'step_pdf', dataAvailabilityStatement: null });

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.KRT_GROUNDING, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
});

test('the consolidator does not list DAS extraction as a dependency', async (t) => {
  // Pinned on the declaration, not just the behaviour: re-adding the dependency
  // would restore the coupling even if the gate stayed gone, because a step
  // waits for every dependency to reach a terminal state.
  const step = orchestrator.PIPELINE.find((s) => s.jobType === JOB_TYPES.PDF_ANALYSIS);
  assert.ok(step, 'PDF Analysis must be in the pipeline');
  assert.ok(!step.dependsOn.includes(JOB_TYPES.DAS_EXTRACTION),
    'the consolidator does not read the Availability Statement');
  assert.equal(step.canAutoAdvance, undefined,
    'and it has no condition of its own — its dependencies are the whole rule');
});

// ─────────────────────────────────────────────────────────────────────────────
// The Availability Statement check — a step gated to a later stage
// ─────────────────────────────────────────────────────────────────────────────

test('starting a pipeline seeds a row for the DAS check, waiting', async (t) => {
  // Without a row there is nothing for the gate to release later: tryAdvanceStep
  // only ever acts on a row that already exists.
  //
  // Asserted on the OUTCOME — a row exists, and it is waiting — rather than on
  // `create` having been called. runAllProcesses reuses the round's rows when
  // they are already there, so counting inserts would test the implementation
  // and fail for a submission that already has its set.
  const rows = new Map();          // nothing seeded yet
  mockDb(t, rows);
  t.mock.method(SubmissionJob, 'create', async (attrs) => {
    const r = row(attrs.jobType, attrs);
    rows.set(attrs.jobType, r);
    return r;
  });

  await orchestrator.runAllProcesses('sub-1', 'user-1', 1);

  const dasRow = rows.get(JOB_TYPES.DAS_SUGGESTIONS);
  assert.ok(dasRow, 'the pipeline must have a row for the step it will later release');
  assert.equal(dasRow.status, 'waiting', 'held until the Availability step');
});

test('re-starting a pipeline that already has rows does not add a second set', async (t) => {
  // The rival-row failure, twelve rows at a time. runAllProcesses runs on every
  // PDF upload and from POST /processes/run, and used to INSERT unconditionally.
  const rows = pipelineRows();
  for (const r of rows.values()) { r.status = 'complete'; r.result = { data: {} }; }
  mockDb(t, rows);
  const created = [];
  t.mock.method(SubmissionJob, 'create', async (attrs) => { created.push(attrs.jobType); return row(attrs.jobType, attrs); });

  await orchestrator.runAllProcesses('sub-1', 'user-1', 1);

  assert.deepEqual(created, [], 'every step already had a row — none may be inserted');
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).result, null, 'and the previous run is cleared');
});

test('finishing DAS extraction does NOT start the check before the Availability step', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  mockDb(t, rows, { id: 'sub-1', status: 'step_pdf', dataAvailabilityStatement: A_STATEMENT });

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DAS_EXTRACTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'waiting',
    'its dependency is done, but the step it is about has not been reached');
  assert.equal(enqueued.length, 0);
});

test('reaching the Availability step, with the statement confirmed, releases it', async (t) => {
  // This is what the status-change handler does: re-drive the pipeline once the
  // submission moves.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  mockDb(t, rows, {
    id: 'sub-1',
    status: 'step_as',
    dataAvailabilityStatement: A_STATEMENT,
    dasConfirmedAt: new Date('2026-08-22T10:00:00Z')
  });

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'queued');
});

test('an unconfirmed statement parks it awaiting the author', async (t) => {
  // The statement is there and the step has been reached — but nobody has said
  // it is the right statement. Extraction pulls it out of the PDF automatically
  // and gets it wrong often enough to matter; checking a paragraph the author
  // has never read spends an LM call to answer the wrong question, and the
  // answer is then reported as theirs.
  //
  // `pending_input`, not `waiting`: this needs a person, and the panel says so.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  mockDb(t, rows, {
    id: 'sub-1', status: 'step_as', dataAvailabilityStatement: A_STATEMENT, dasConfirmedAt: null
  });

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'pending_input');
  // The sweep releases the rest of the pipeline in the same pass, so the check
  // is that THIS queue stayed empty — not that nothing ran at all.
  assert.ok(!enqueued.includes(jobQueue.QUEUES.DAS_SUGGESTIONS), 'and nothing was spent on it');
});

test('but a person asking for it by name is the confirmation', async (t) => {
  // canAutoAdvance governs AUTO advancing. A manual run is somebody clicking
  // the step, next to the statement they are looking at — parking that in
  // `pending_input`, which nothing revisits, would strand a job the user just
  // asked for.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  mockDb(t, rows, {
    id: 'sub-1', status: 'step_as', dataAvailabilityStatement: A_STATEMENT, dasConfirmedAt: null
  });

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.DAS_SUGGESTIONS, 1, 'user-1');

  assert.equal(job.status, 'queued');
});

test('but not without a statement to check', async (t) => {
  for (const das of ['', '   ', null, 'Not found']) {
    const rows = pipelineRows();
    completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
    mockDb(t, rows, { id: 'sub-1', status: 'step_as', dataAvailabilityStatement: das });

    await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

    assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'waiting',
      `${JSON.stringify(das)} is not a statement — running would burn an LM call on nothing`);
    t.mock.restoreAll();
  }
});

test('a statement typed in later releases it, with no new row', async (t) => {
  // The extraction result still says "not found"; the gate reads the
  // submission's current statement, which is what the author just edited.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  rows.get(JOB_TYPES.DAS_EXTRACTION).result = { status: { detected: false } };
  mockDb(t, rows, { id: 'sub-1', status: 'step_as', dataAvailabilityStatement: 'I wrote this myself.' });
  const before = rows.get(JOB_TYPES.DAS_SUGGESTIONS);

  const job = await orchestrator.requeueStep('sub-1', JOB_TYPES.DAS_SUGGESTIONS, 1, 'user-1');

  assert.equal(job, before, 'the re-run reuses the round\'s row');
  assert.equal(SubmissionJob.create.mock.callCount(), 0);
  assert.equal(job.status, 'queued');
});

test('nothing downstream waits for it', async (t) => {
  // It is gated to the last stage, so anything depending on it would inherit
  // that gate and stall for a reason of its own that has nothing to do with it.
  for (const step of orchestrator.PIPELINE) {
    assert.ok(!step.dependsOn.includes(JOB_TYPES.DAS_SUGGESTIONS),
      `${step.jobType} must not depend on the DAS check`);
  }
});

/**
 * checkAndAdvance runs on every worker completion. pdf_analysis sits behind
 * eight detections that finish within milliseconds of each other, so two
 * completions genuinely overlap: both read the row as `waiting`, both found
 * every dependency terminal, and both enqueued it. Two pg-boss jobs for one
 * row means the same model call runs twice, is paid for twice, and both
 * results are written over the same row.
 */
/**
 * A barrier that releases only once `parties` callers have reached it.
 *
 * Without one, this test does not test anything: the fakes resolve in a single
 * microtask, so the first caller finishes its whole advance before the second
 * starts, and the second is turned away by the `status !== 'waiting'` guard at
 * the top of tryAdvanceStep rather than by the claim. Holding both callers
 * until each has read the jobs map reproduces the real interleaving — two
 * advances that have both seen `waiting`.
 */
function barrier(parties) {
  let arrived = 0;
  let release;
  const open = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrived++;
    if (arrived >= parties) release();
    return open;
  };
}

test('two dependencies finishing at once enqueue the step exactly once', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);
  enqueued.length = 0;

  // Each advance gets its OWN row objects, as two requests loading the same
  // row from Postgres would. Sharing one object per type — which is what the
  // shared fake does — lets the first advance's `job.status = 'queued'` be
  // seen by the second through the same reference, so the in-memory guard
  // turns it away and the race can never be observed.
  const canonical = rows;
  t.mock.method(SubmissionJob, 'getForSubmission', async () => (
    [...canonical.values()].map((r) => ({
      ...r,
      async save() {
        Object.assign(canonical.get(this.jobType), {
          status: this.status, pgBossJobId: this.pgBossJobId
        });
        return this;
      }
    }))
  ));

  // Both advances read the jobs map, THEN both are let go.
  const bothHaveRead = barrier(2);
  t.mock.method(Submission, 'findByPk', async () => {
    await bothHaveRead();
    return { id: 'sub-1', status: 'step_pdf', dataAvailabilityStatement: A_STATEMENT };
  });

  await Promise.all([
    orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1),
    orchestrator.checkAndAdvance('sub-1', JOB_TYPES.MATERIALS_DETECTION, 1)
  ]);

  const analysisEnqueues = enqueued.filter((q) => q === jobQueue.QUEUES.PDF_ANALYSIS);
  assert.equal(analysisEnqueues.length, 1,
    `pdf_analysis was enqueued ${analysisEnqueues.length} times — two workers each ` +
    'paid for the same model call and wrote over one row');
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
});

test('a step already past waiting is never re-claimed by a concurrent advance', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.PDF_ANALYSIS).status = 'processing';   // a worker has it
  mockDb(t, rows);
  enqueued.length = 0;

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1);

  assert.equal(enqueued.filter((q) => q === jobQueue.QUEUES.PDF_ANALYSIS).length, 0);
  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'processing',
    'a running step must not be dragged back to queued');
});

test('a failed enqueue puts the claim back instead of stranding the row', async (t) => {
  // `queued` with no pgBossJobId is the one state no reconciler heals: it
  // watches `processing` and `waiting`.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);
  t.mock.method(jobQueue, 'addJob', async () => { throw new Error('queue unreachable'); });

  await assert.rejects(
    () => orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1),
    /queue unreachable/
  );

  const analysis = rows.get(JOB_TYPES.PDF_ANALYSIS);
  assert.equal(analysis.status, 'waiting', 'the claim must be released');
  assert.equal(analysis.pgBossJobId, null);
});

test('releasing a gated step continues the run rather than starting a new one', async (t) => {
  // Found by running the real pipeline. `das_suggestions` waits behind the
  // Availability step and never starts on its own, so confirming the statement
  // arrives here — and opened run 2, superseding run 1, purely to run a step
  // run 1 had never got to. The history then claimed a restart the user never
  // asked for, and relabelled eleven finished steps as carried over.
  const rows = pipelineRows({ [JOB_TYPES.DAS_SUGGESTIONS]: { status: 'waiting' } });
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  mockDb(t, rows, {
    id: 'sub-1', status: 'step_as',
    dataAvailabilityStatement: A_STATEMENT, dasConfirmedAt: new Date()
  });
  pipelineRuns.neverRan(JOB_TYPES.DAS_SUGGESTIONS);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.DAS_SUGGESTIONS, 1, 'user-1');

  assert.equal(pipelineRuns.created.length, 0, 'the run is reaching the step, not repeating it');
  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'queued', 'and it still runs');
});

test('but re-running a step that HAS already run in this run is a new run', async (t) => {
  const rows = finishedRound(t);
  completeUpstreamOf(rows, JOB_TYPES.SOFTWARE_DETECTION);

  await orchestrator.requeueStep('sub-1', JOB_TYPES.SOFTWARE_DETECTION, 1, 'user-1');

  assert.equal(pipelineRuns.created.length, 1);
  assert.equal(pipelineRuns.created[0].cause, 'restart');
});

// ─────────────────────────────────────────────────────────────────────────────
// A run reaches a state of its own
//
// Found by running the real pipeline: all twelve steps finished and the run
// still said `running`. That is the same shape of lie `superseded` was added to
// avoid — a status describing an attempt that stopped happening some time ago.
// ─────────────────────────────────────────────────────────────────────────────

test('a run whose every step has finished is complete', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 5000 } };
  mockDb(t, rows);

  await orchestrator.settleRun('sub-1', 1, rows);

  assert.equal(pipelineRuns.current.status, 'complete');
  assert.ok(pipelineRuns.current.completedAt);
});

test('a run held behind an undecided failure is paused, not complete', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 5000 } };
  // Terminal, so every step has "finished" — and still needs a person.
  Object.assign(rows.get(JOB_TYPES.DATASETS_DETECTION), { status: 'failed', decision: null });
  mockDb(t, rows);

  await orchestrator.settleRun('sub-1', 1, rows);

  assert.equal(pipelineRuns.current.status, 'paused');
  assert.equal(pipelineRuns.current.completedAt, null);
});

test('a run with a step still going stays running', async (t) => {
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 5000 } };
  rows.get(JOB_TYPES.PDF_ANALYSIS).status = 'processing';
  mockDb(t, rows);

  await orchestrator.settleRun('sub-1', 1, rows);

  assert.equal(pipelineRuns.current.status, 'running');
});

test('a run that was already superseded is left alone', async (t) => {
  // It was replaced before it finished. Marking it complete afterwards would
  // erase the one fact that distinguishes it from a run that ran to the end.
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 5000 } };
  mockDb(t, rows);
  pipelineRuns.current.status = 'superseded';

  await orchestrator.settleRun('sub-1', 1, rows);

  assert.equal(pipelineRuns.current.status, 'superseded');
});

test('a failed run still completes — the outcome lives on its steps', async (t) => {
  // "Complete" is about the ATTEMPT, not about whether it went well. A run
  // whose steps failed and were carried past has finished; a run-level verdict
  // would be a second, coarser answer to a question the executions answer
  // better.
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 5000 } };
  Object.assign(rows.get(JOB_TYPES.DATASETS_DETECTION), {
    status: 'failed',
    decision: { at: '2026-08-22T12:00:00Z', byUserId: 'user-1' }
  });
  mockDb(t, rows);

  await orchestrator.settleRun('sub-1', 1, rows);

  assert.equal(pipelineRuns.current.status, 'complete');
});

test('the LAST step finishing settles the run, though nothing depends on it', async (t) => {
  // The hole in the first version of settleRun: checkAndAdvance returned early
  // when a step had no dependents, which is precisely the final step of a run.
  // The run that had just finished sat at `running` until the five-minute
  // reconciler noticed. Seen on the first live run.
  const rows = pipelineRows();
  for (const r of rows.values()) r.status = 'complete';
  rows.get(JOB_TYPES.MARKDOWN_CONVERT).result = { data: { markdownLength: 5000 } };
  mockDb(t, rows, {
    id: 'sub-1', status: 'step_as',
    dataAvailabilityStatement: A_STATEMENT, dasConfirmedAt: new Date()
  });

  // das_suggestions is the tail: no step declares it as a dependency.
  const tail = orchestrator.PIPELINE.filter(
    (s) => orchestrator.PIPELINE.some((o) => o.dependsOn.includes(s.jobType))
  ).map((s) => s.jobType);
  assert.ok(!tail.includes(JOB_TYPES.DAS_SUGGESTIONS), 'das_suggestions must have no dependents');

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DAS_SUGGESTIONS, 1);

  assert.equal(pipelineRuns.current.status, 'complete');
});

test('restarting a step revives the dependents a cancel had stopped', async (t) => {
  // Found live: cancel the pipeline, restart the step, and its cancelled
  // dependents sat `cancelled` for ever while the step they were waiting for
  // ran to completion. Asking for a step to run again is asking for what
  // depends on it to run again, whatever stopped them last time.
  const rows = pipelineRows({
    [JOB_TYPES.SOFTWARE_DETECTION]: { status: 'cancelled' },
    [JOB_TYPES.KRT_GROUNDING]: { status: 'cancelled' },
    [JOB_TYPES.PDF_ANALYSIS]: { status: 'cancelled' },
    [JOB_TYPES.SUGGESTION_GENERATION]: { status: 'cancelled' }
  });
  mockDb(t, rows);

  const reset = await orchestrator.cascadeRestart('sub-1', JOB_TYPES.SOFTWARE_DETECTION, 1, 'user-1');

  for (const jobType of [JOB_TYPES.KRT_GROUNDING, JOB_TYPES.PDF_ANALYSIS, JOB_TYPES.SUGGESTION_GENERATION]) {
    assert.equal(rows.get(jobType).status, 'waiting', `${jobType} must be revived`);
    assert.ok(reset.includes(jobType));
  }
});

test('but a dependent still in flight is left alone', async (t) => {
  // Resetting it would abandon work already under way and pay for it twice.
  const rows = pipelineRows({
    [JOB_TYPES.SOFTWARE_DETECTION]: { status: 'complete' },
    [JOB_TYPES.KRT_GROUNDING]: { status: 'processing' }
  });
  mockDb(t, rows);

  await orchestrator.cascadeRestart('sub-1', JOB_TYPES.SOFTWARE_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.KRT_GROUNDING).status, 'processing');
});
