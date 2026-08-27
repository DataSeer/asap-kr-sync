/**
 * What "Cancel" means for a module that is already talking to an external API.
 *
 * The rule: **a cancel interrupts.** Every step that has not finished becomes
 * `cancelled`, unusable, and must be re-run — including the one actually
 * running. It used to be left alone to finish and record its real result, which
 * meant pressing Cancel on the one thing burning money did nothing a user could
 * see: the module carried on and the pipeline treated its answer as a success.
 *
 * What genuinely cannot be interrupted is the external CALL. The promise is
 * abandoned, the call completes, and it is billed. So the answer is recorded on
 * the execution as DISCARDED, with what it cost — dropping it silently means
 * the money was spent and the record says nothing.
 *
 * Five properties, each breakable on its own:
 *
 *   1. a `processing` job is cancelled like the rest;
 *   2. its queue entry is pulled, so no retry re-starts the work;
 *   3. everything not yet started is cancelled too;
 *   4. the late answer is recorded as discarded, not as a result;
 *   5. and dependents still do not run.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob, Submission } = require('../models');
const jobQueue = require('../services/queue/job-queue.service');
const orchestrator = require('../services/queue/orchestrator.service');
const controller = require('./jobs.controller');
const { callController } = require('../test-helpers/fake-transaction');
const runHistory = require('../services/queue/run-history.service');
const { JOB_TYPES } = require('../config/constants');

const SUBMISSION_ID = 'sub-1';

function row(jobType, status, over = {}) {
  const r = {
    id: `${jobType}-row`,
    jobType,
    submissionId: SUBMISSION_ID,
    round: 1,
    status,
    pgBossJobId: `pgboss-${jobType}`,
    result: null,
    errorMessage: null,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    async save() { return this; },
    // markComplete reloads before deciding, which is exactly how its guard sees
    // a cancel written by a DIFFERENT instance — the controller marked the row
    // cancelled while this worker held its own copy. Here the test's row IS the
    // row, so the reload is a no-op and the status is already current.
    async reload() { return this; },
    async markCancelled(userId) { this.status = 'cancelled'; this.cancelledBy = userId || null; },
    async markPendingInput() { this.status = 'pending_input'; },
    changed() { /* the real markComplete calls this */ },
    ...over
  };
  // The model's own markComplete, not a re-implementation: its guard ("never
  // resurrect a cancelled job") is one of the things under test, and a stub
  // would only ever be testing the stub.
  r.markComplete = SubmissionJob.prototype.markComplete.bind(r);
  return r;
}

function mockQueue(t, rows) {
  const cancelledInQueue = [];
  t.mock.method(SubmissionJob, 'getForSubmission', async () => rows);
  t.mock.method(SubmissionJob, 'getLatest', async (_s, jobType) => rows.find(r => r.jobType === jobType) || null);
  t.mock.method(Submission, 'findByPk', async () => ({
    id: SUBMISSION_ID, status: 'step_pdf', dataAvailabilityStatement: 'Data at Zenodo.'
  }));
  t.mock.method(jobQueue, 'cancelJob', async (queue, id) => { cancelledInQueue.push(id); });
  t.mock.method(jobQueue, 'addJob', async () => 'new-pgboss-id');
  return cancelledInQueue;
}

const request = () => ({
  params: { id: SUBMISSION_ID },
  submission: { id: SUBMISSION_ID, currentRound: 1, status: 'step_pdf' },
  userId: 'user-1'
});

// ─────────────────────────────────────────────────────────────────────────────

test('a module mid-call is cancelled like everything else', async (t) => {
  const running = row(JOB_TYPES.MATERIALS_DETECTION, 'processing');
  const rows = [running, row(JOB_TYPES.PDF_ANALYSIS, 'waiting')];
  mockQueue(t, rows);

  const { body } = await callController(controller.cancelProcessing, request());

  assert.equal(running.status, 'cancelled', 'Cancel must stop the thing actually running');
  assert.equal(body.cancelled, 2);
  // Still reported, because its answer is still coming and will be recorded as
  // discarded — the user is told there is a call they have already paid for.
  assert.equal(body.stillRunning, 1);
});

test('its queue entry is pulled, so no retry re-starts the work', async (t) => {
  // The call in flight cannot be stopped. A pg-boss RETRY of it can, and would
  // be a second call the user has already said they do not want.
  const running = row(JOB_TYPES.MATERIALS_DETECTION, 'processing');
  const cancelledInQueue = mockQueue(t, [running, row(JOB_TYPES.PDF_ANALYSIS, 'waiting')]);

  await callController(controller.cancelProcessing, request());

  assert.ok(cancelledInQueue.includes('pgboss-materials_detection'));
});

test('everything not yet started is cancelled too', async (t) => {
  const rows = [
    row(JOB_TYPES.MATERIALS_DETECTION, 'processing'),
    row(JOB_TYPES.PDF_ANALYSIS, 'waiting'),
    row(JOB_TYPES.SUGGESTION_GENERATION, 'queued'),
    row(JOB_TYPES.DAS_SUGGESTIONS, 'pending_input')
  ];
  mockQueue(t, rows);

  const { body } = await callController(controller.cancelProcessing, request());

  assert.equal(body.cancelled, 4);
  for (const r of rows) {
    assert.equal(r.status, 'cancelled', `${r.jobType} must not start after a cancel`);
  }
});

test('the late answer is recorded as discarded, not kept as the result', async (t) => {
  // The call completed and was billed. Dropping it silently means the money was
  // spent and the record says nothing — "did we pay for something we threw
  // away" is the question this exists to answer.
  const running = row(JOB_TYPES.MATERIALS_DETECTION, 'processing');
  mockQueue(t, [running, row(JOB_TYPES.PDF_ANALYSIS, 'waiting')]);
  const discarded = [];
  t.mock.method(runHistory, 'recordDiscarded', async (job, what) => {
    discarded.push({ jobType: job.jobType, ...what });
  });

  await callController(controller.cancelProcessing, request());
  await running.markComplete({ counts: { unique: 3 }, data: { items: [1, 2, 3] } });

  assert.equal(running.status, 'cancelled', 'the cancel stands');
  assert.equal(running.result, null, 'and the answer is not its result');
  assert.deepEqual(discarded, [
    { jobType: JOB_TYPES.MATERIALS_DETECTION, outcome: 'done', counts: { unique: 3 } }
  ]);
});

test('a failure arriving after the cancel is recorded too', async (t) => {
  // It is still something that happened, and still something that was paid for.
  const running = row(JOB_TYPES.MATERIALS_DETECTION, 'processing');
  running.markFailed = SubmissionJob.prototype.markFailed.bind(running);
  mockQueue(t, [running, row(JOB_TYPES.PDF_ANALYSIS, 'waiting')]);
  const discarded = [];
  t.mock.method(runHistory, 'recordDiscarded', async (job, what) => discarded.push(what));

  await callController(controller.cancelProcessing, request());
  await running.markFailed('Gemini 503');

  assert.equal(running.status, 'cancelled', 'not `failed` — the failure is a consequence of the cancel');
  assert.deepEqual(discarded, [{ outcome: 'fail', error: 'Gemini 503' }]);
});

test('...and the next module still does not start', async (t) => {
  // The property that makes the whole design safe. The dependent was cancelled
  // by the cancel; when the in-flight module completes and drives the pipeline,
  // `tryAdvanceStep` only ever starts a job that is still `waiting`.
  //
  // Every OTHER dependency of PDF Analysis is complete here on purpose: with
  // one missing, the step is held for an unrelated reason and this test would
  // pass no matter what the cancel did.
  const running = row(JOB_TYPES.MATERIALS_DETECTION, 'processing');
  const dependent = row(JOB_TYPES.PDF_ANALYSIS, 'waiting');
  const pdfStep = orchestrator.PIPELINE.find((s) => s.jobType === JOB_TYPES.PDF_ANALYSIS);
  const others = pdfStep.dependsOn
    .filter((d) => d !== JOB_TYPES.MATERIALS_DETECTION)
    .map((d) => row(d, 'complete', {
      result: d === JOB_TYPES.DAS_EXTRACTION
        ? { status: { detected: true } }
        : { data: { markdownLength: 5000 } }
    }));
  const enqueued = [];
  const rows = [running, dependent, ...others];
  mockQueue(t, rows);
  t.mock.method(jobQueue, 'addJob', async (queue) => { enqueued.push(queue); return 'x'; });

  t.mock.method(runHistory, 'recordDiscarded', async () => {});
  await callController(controller.cancelProcessing, request());
  await running.markComplete({ data: { items: [] } });
  await orchestrator.checkAndAdvance(SUBMISSION_ID, JOB_TYPES.MATERIALS_DETECTION, 1, 'user-1');

  assert.equal(dependent.status, 'cancelled', 'it was cancelled and must stay so');
  assert.equal(enqueued.length, 0, 'nothing may be enqueued after a cancel');
});

test('a worker that finishes after the cancel cannot resurrect a cancelled job', async (t) => {
  // The other half: if a module was still `queued` when the cancel landed and a
  // worker picks it up anyway, completing it would restart the pipeline behind
  // the user's back. The model refuses.
  const cancelled = row(JOB_TYPES.PDF_ANALYSIS, 'queued');
  mockQueue(t, [row(JOB_TYPES.MATERIALS_DETECTION, 'processing'), cancelled]);

  t.mock.method(runHistory, 'recordDiscarded', async () => {});
  await callController(controller.cancelProcessing, request());
  assert.equal(cancelled.status, 'cancelled');

  await cancelled.markComplete({ data: { items: [1] } });

  assert.equal(cancelled.status, 'cancelled', 'a cancelled job must stay cancelled');
  assert.equal(cancelled.result, null, 'and must not record a result');
});

test('a cancelled round suppresses retries of the module that was mid-flight', async (t) => {
  // If the in-flight module FAILS after the cancel, that failure is a
  // consequence of the cancel. Retrying it would restart external work the user
  // asked to stop — pg-boss retries on a throw, so the worker must not rethrow.
  const rows = [row(JOB_TYPES.MATERIALS_DETECTION, 'processing'), row(JOB_TYPES.PDF_ANALYSIS, 'cancelled')];
  t.mock.method(SubmissionJob, 'findAll', async () => rows);

  assert.equal(await SubmissionJob.isRoundCancelled(SUBMISSION_ID, 1), true,
    'one cancelled job marks the whole round as cancelled — that is the signal the worker reads');
});

test('a round with nothing cancelled is not treated as cancelled', async (t) => {
  const rows = [row(JOB_TYPES.MATERIALS_DETECTION, 'processing'), row(JOB_TYPES.PDF_ANALYSIS, 'waiting')];
  t.mock.method(SubmissionJob, 'findAll', async () => rows);

  assert.equal(await SubmissionJob.isRoundCancelled(SUBMISSION_ID, 1), false);
});

test('who cancelled is recorded, so the interruption is attributable', async (t) => {
  // "This run was stopped" needs a name on it for the same reason the decision
  // to continue past a failure does: the alternative is a result that is
  // missing for a reason nobody can find.
  const running = row(JOB_TYPES.MATERIALS_DETECTION, 'processing');
  mockQueue(t, [running, row(JOB_TYPES.PDF_ANALYSIS, 'waiting')]);

  await callController(controller.cancelProcessing, request());

  assert.equal(running.cancelledBy, 'user-1');
});
