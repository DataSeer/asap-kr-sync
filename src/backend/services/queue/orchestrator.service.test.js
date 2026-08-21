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

const { SubmissionJob, Submission } = require('../../models');
const jobQueue = require('./job-queue.service');
const orchestrator = require('./orchestrator.service');
const { JOB_TYPES } = require('../../config/constants');

// ── a job row that behaves like the model instance the code writes to ────────
let saved;      // every row .save() was called on, in order
let enqueued;   // every queue name addJob() was called with

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

beforeEach(() => { saved = []; enqueued = []; });
afterEach(() => { saved = []; enqueued = []; });

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

test('a step whose dependency FAILED still advances — failure is terminal too', async (t) => {
  // Otherwise one failed detector strands the whole run in `waiting`, and the
  // curator sees a pipeline that never finishes rather than a partial result.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DATASETS_DETECTION).status = 'failed';
  rows.get(JOB_TYPES.DATASETS_DETECTION).result = null;
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.DATASETS_DETECTION, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
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
  // backoff read DAS extraction as finished, evaluated PDF Analysis's gate
  // against a result that was not there yet, and parked it in `pending_input` —
  // which nothing revisits. When the retry then succeeded, the advance found
  // PDF Analysis no longer `waiting` and did nothing. Only a manual advance
  // recovered it.
  //
  // A retrying job now stays `processing`, so the dependents stay `waiting`.
  const rows = pipelineRows();
  // Everything PDF Analysis needs is done — except DAS extraction, which is
  // between attempts and has no result yet.
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DAS_EXTRACTION).status = 'processing';
  rows.get(JOB_TYPES.DAS_EXTRACTION).result = null;
  rows.get(JOB_TYPES.DAS_EXTRACTION).errorMessage = 'Gemini 503 — retrying';
  mockDb(t, rows);

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'waiting',
    'PDF Analysis must wait for the retry, not be parked awaiting input');
});

test('a dependency that has genuinely failed does release its dependents', async (t) => {
  // The other half of the rule: once pg-boss has given up, `failed` IS terminal
  // and the pipeline must move rather than wait for ever. DAS extraction is the
  // case that matters — it fails, PDF Analysis's gate finds no statement, and
  // the step parks in `pending_input` asking the user to type one. That is the
  // designed path, and it is only reachable because the failure is terminal.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DAS_EXTRACTION).status = 'failed';
  rows.get(JOB_TYPES.DAS_EXTRACTION).result = null;
  mockDb(t, rows);

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'pending_input',
    'a terminal failure must not leave the dependent waiting for ever');
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

test('every step that reads the manuscript waits for BOTH gates', () => {
  const readsManuscript = [
    JOB_TYPES.SOFTWARE_DETECTION, JOB_TYPES.DATASETS_DETECTION,
    JOB_TYPES.MATERIALS_DETECTION, JOB_TYPES.PROTOCOLS_DETECTION,
    JOB_TYPES.IDENTIFIER_DETECTION
  ];
  for (const jobType of readsManuscript) {
    const gates = orchestrator.PIPELINE.find((s) => s.jobType === jobType).gate;
    assert.deepEqual([...gates].sort(), ['krt_curated', 'markdown_ready'],
      `${jobType} must wait for a converted manuscript AND a curated KRT`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The DAS gate on pdf_analysis — the rule that parks a run awaiting the user
// ─────────────────────────────────────────────────────────────────────────────

test('no Availability Statement parks the consolidator awaiting input', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  rows.get(JOB_TYPES.DAS_EXTRACTION).result = { status: { detected: false } };
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.KRT_GROUNDING, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'pending_input',
    'the user has to supply the statement — this is not a failure');
  assert.equal(enqueued.length, 0);
});

test('a DAS extraction that completed without a verdict also parks it', async (t) => {
  // `detected` must be exactly true. A result missing the field is not consent
  // to run — that is how a half-written result would slip through.
  for (const result of [null, {}, { status: {} }, { status: { detected: 'yes' } }]) {
    const rows = pipelineRows();
    completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
    rows.get(JOB_TYPES.DAS_EXTRACTION).result = result;
    mockDb(t, rows);

    await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.KRT_GROUNDING, 1, 'user-1');

    assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'pending_input',
      `result ${JSON.stringify(result)} must not auto-advance`);
    t.mock.restoreAll();
  }
});

test('a found Availability Statement lets the consolidator run', async (t) => {
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.PDF_ANALYSIS);
  mockDb(t, rows);

  await orchestrator.checkAndAdvance('sub-1', JOB_TYPES.KRT_GROUNDING, 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.PDF_ANALYSIS).status, 'queued');
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

test('reaching the Availability step releases it', async (t) => {
  // This is what the status-change handler does: re-drive the pipeline once the
  // submission moves.
  const rows = pipelineRows();
  completeUpstreamOf(rows, JOB_TYPES.DAS_SUGGESTIONS);
  mockDb(t, rows, { id: 'sub-1', status: 'step_as', dataAvailabilityStatement: A_STATEMENT });

  await orchestrator.reconcileSubmission('sub-1', 1, 'user-1');

  assert.equal(rows.get(JOB_TYPES.DAS_SUGGESTIONS).status, 'queued');
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
