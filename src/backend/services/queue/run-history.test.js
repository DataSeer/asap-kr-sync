'use strict';

/**
 * The pipeline's logbook.
 *
 * Two properties matter more than the rest, and both are easy to get wrong in a
 * way nothing notices:
 *
 *   1. **It never breaks a run.** Every write is wrapped. If that guard is lost,
 *      a bug in the audit trail starts failing pipeline steps that otherwise
 *      succeeded — trading working software for bookkeeping.
 *   2. **A pg-boss retry is not a new run.** Retries are attempts WITHIN a run.
 *      Counting them as runs would make "run 7" mean "the service was flaky",
 *      not "somebody asked for this seven times".
 *
 * The guard in (1) also means a broken write is SILENT, so these tests assert
 * the writes actually happen rather than merely that nothing threw.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const runHistory = require('./run-history.service');
const { fakePipelineRuns } = require('../../test-helpers/fake-pipeline-runs');

const JOB = {
  id: 'job-1',
  submissionId: 'sub-1',
  jobType: 'software_detection',
  round: 1,
  status: 'complete',
  retryCount: 0,
  result: {
    counts: { unique: 18 },
    timing: { totalMs: 15700 },
    service: { outcome: { state: 'partial', source: 'external', failReason: 'softcite_failed', externalError: 'Service error' } }
  },
  logs: [{ step: 'start' }]
};

/** Stand in for the DB: records what was written, hands back what was asked. */
function fakeDb(t, { existingRuns = [] } = {}) {
  const state = { inserted: [], incremented: [], run: null };

  // An execution is filed under the round's current pipeline run, and is
  // refused if there is none. That resolution is the run layer's business; what
  // these tests are about is what gets WRITTEN, so it is stubbed and the
  // attachment recorded.
  state.pipeline = fakePipelineRuns(t);

  t.mock.method(models.sequelize, 'query', async (sql, opts) => {
    assert.match(sql, /INSERT INTO "step_executions"/, 'openRun must insert');
    const next = existingRuns.length + 1;
    existingRuns.push(next);
    state.inserted.push({ ...opts.replacements });
    return [[{ id: `run-${next}` }]];
  });

  state.incremented = [];
  t.mock.method(models.SubmissionJob, 'increment', async (field, opts) => {
    state.incremented.push({ field, by: opts.by, id: opts.where.id });
    return [1];
  });

  state.run = {
    runNumber: existingRuns.length || 1,
    updates: [],
    async update(fields) { this.updates.push(fields); Object.assign(this, fields); return this; }
  };
  t.mock.method(models.StepExecution, 'findByPk', async () => state.run);
  t.mock.method(models.StepExecution, 'findOne', async () => state.run);

  return state;
}

test('an execution is filed under the round\'s pipeline run', async (t) => {
  const state = fakeDb(t);

  await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'manual' });

  assert.equal(state.inserted[0].pipelineRunId, 'pipeline-run-1');
  // Keyed by the PIPELINE run number, so "everything run 2 produced" is one
  // prefix per step rather than a lookup — and the number in the path is the
  // number the user was shown.
  assert.equal(state.inserted[0].pipelineRunNumber, 1);
  assert.deepEqual(state.pipeline.attached, [
    { pipelineRunId: 'pipeline-run-1', jobType: 'software_detection', stepExecutionId: 'run-1' }
  ]);
});

test('a step enqueued outside any run writes nothing rather than an orphan', async (t) => {
  // An execution belonging to no run is unreachable from the model every screen
  // is built on: it would sit in the table and appear nowhere. A loud error and
  // no row beats a record that cannot be found.
  const state = fakeDb(t);
  state.pipeline.current = null;

  const result = await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'manual' });

  assert.equal(result, null);
  assert.deepEqual(state.inserted, []);
});

test('an execution carries no number of its own', async (t) => {
  // It used to be numbered per step, and that number meant something different
  // from the one the user was shown — the ambiguity this model removed. The
  // pipeline run numbers the attempt; UNIQUE(pipeline_run_id, job_type) is what
  // now stops a step executing twice in one run and one of the two vanishing.
  const state = fakeDb(t);

  await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'manual' });

  assert.equal(state.inserted[0].run_number, undefined);
  assert.equal(state.inserted[0].pipelineRunId, 'pipeline-run-1');
  assert.equal(state.inserted[0].pipelineRunNumber, 1);
});

test('opening a run records who asked, and how', async (t) => {
  const state = fakeDb(t);

  await runHistory.openRun(JOB, { userId: 'curator-1', triggerKind: 'manual' });

  const [row] = state.inserted;
  assert.equal(row.userId, 'curator-1');
  assert.equal(row.triggerKind, 'manual');
  assert.equal(row.jobType, 'software_detection');
  assert.equal(row.round, 1);
});

test('a run nobody asked for is still recorded, with no user', async (t) => {
  // A worker finishing releases the next step. Nobody clicked, and the record
  // says so rather than inventing an actor.
  const state = fakeDb(t);

  await runHistory.openRun(JOB, { userId: null, triggerKind: 'pipeline' });

  assert.equal(state.inserted[0].userId, null);
  assert.equal(state.inserted[0].triggerKind, 'pipeline');
});

test('opening an execution counts it against the step', async (t) => {
  // NOT the run number — that belongs to the pipeline run. This answers "has
  // this step been re-run", which a carried-over step makes a different
  // question from "which run is this".
  const state = fakeDb(t);

  await runHistory.openRun(JOB, {});
  await runHistory.openRun(JOB, {});

  assert.equal(state.incremented.length, 2);
  assert.deepEqual(state.incremented[0], { field: 'runCount', by: 1, id: 'job-1' });
});

test('closing a run copies the outcome, counts and timings off the job row', async (t) => {
  const state = fakeDb(t, { existingRuns: [1] });

  await runHistory.closeRun({ ...JOB, startedAt: new Date('2026-08-22T10:00:00Z'), completedAt: new Date('2026-08-22T10:00:15Z') });

  const [written] = state.run.updates;
  assert.equal(written.status, 'complete');
  assert.equal(written.outcomeState, 'partial', 'a degraded run must be recorded as degraded');
  assert.equal(written.failReason, 'softcite_failed');
  assert.equal(written.externalError, 'Service error');
  assert.equal(written.durationMs, 15700);
  assert.deepEqual(written.counts, { unique: 18 });
  assert.ok(written.result, 'the payload is kept');
});

test('a disabled module records a run with an empty payload', async (t) => {
  // No inputs, no outputs, but the same metadata as any other run — and the
  // frozen config is what makes the empty result readable as "switched off"
  // rather than "found nothing".
  const state = fakeDb(t, { existingRuns: [1] });
  const off = {
    ...JOB,
    result: { data: { items: [] }, service: { config: { state: 'off' }, outcome: { state: 'done', source: null } } }
  };

  await runHistory.closeRun(off);

  const [written] = state.run.updates;
  assert.equal(written.status, 'complete');
  assert.equal(written.outcomeState, 'done');
  assert.equal(written.outcomeSource, null, 'source null is what says nothing was attempted');
  assert.equal(written.result.service.config.state, 'off');
});

test('a retry updates the open run — it does not open a new one', async (t) => {
  const state = fakeDb(t, { existingRuns: [1] });

  await runHistory.touchRun({ ...JOB, retryCount: 2 }, { retryCount: 2, externalError: 'timeout' });

  assert.equal(state.inserted.length, 0, 'no INSERT: a pg-boss attempt is not a run');
  assert.equal(state.run.updates[0].retryCount, 2);
});

test('a history failure never breaks the run', async (t) => {
  // THE rule. A missing history row is recoverable and visible; a pipeline that
  // stops because its logbook threw is neither.
  t.mock.method(models.sequelize, 'query', async () => { throw new Error('db is on fire'); });
  t.mock.method(models.StepExecution, 'findOne', async () => { throw new Error('db is on fire'); });

  await assert.doesNotReject(() => runHistory.openRun(JOB, { userId: 'u1' }));
  await assert.doesNotReject(() => runHistory.closeRun(JOB));
  await assert.doesNotReject(() => runHistory.touchRun(JOB, { retryCount: 1 }));

  assert.equal(await runHistory.openRun(JOB, {}), null, 'and it reports the failure as null');
});

test('closing a run that was never opened is a no-op, not a crash', async (t) => {
  t.mock.method(models.StepExecution, 'findOne', async () => null);

  assert.equal(await runHistory.closeRun(JOB), null);
});

/**
 * The columns this feature added have to exist on the MODELS, not only in the
 * migration.
 *
 * `run_count` was added to the database and not to `SubmissionJob`, so
 * `SubmissionJob.update({ runCount })` silently dropped the field — Sequelize
 * ignores unknown attributes — and the history writes are deliberately guarded,
 * so nothing surfaced. Two runs existed while the job row still said one.
 *
 * The test above did not catch it because it asserted that `update` was CALLED
 * with the right values, against a mock. That is a test of my intention, not of
 * the schema.
 */
test('every column this feature added exists on its model', () => {
  const { SubmissionJob, StepExecution, File, ChangeLog } = models;

  const has = (model, attr, column) => {
    const def = model.rawAttributes[attr];
    assert.ok(def, `${model.name}.${attr} is missing — the migration added the column, the model did not`);
    assert.equal(def.field, column, `${model.name}.${attr} must map to ${column}`);
  };

  has(SubmissionJob, 'runCount', 'run_count');
  has(SubmissionJob, 'triggeredByUserId', 'triggered_by_user_id');
  has(File, 'uploadedByUserId', 'uploaded_by_user_id');
  has(ChangeLog, 'fileId', 'file_id');

  for (const [attr, column] of [
    ['submissionJobId', 'submission_job_id'], ['submissionId', 'submission_id'],
    ['jobType', 'job_type'], ['pipelineRunId', 'pipeline_run_id'],
    ['outcomeState', 'outcome_state'], ['outcomeSource', 'outcome_source'],
    ['failReason', 'fail_reason'], ['externalError', 'external_error'],
    ['triggeredByUserId', 'triggered_by_user_id'], ['triggerKind', 'trigger_kind'],
    ['startedAt', 'started_at'], ['completedAt', 'completed_at'],
    ['durationMs', 'duration_ms'], ['retryCount', 'retry_count'],
    ['s3Prefix', 's3_prefix']
  ]) has(StepExecution, attr, column);
});

/**
 * The documents a run was contemporaneous with.
 *
 * A run freezes what its MODULE read — `software_detection` records only the
 * markdown, and no detector ever opens the KRT — so without this there is no
 * way to say which table or which PDF a run belonged to. Recorded when the run
 * opens, by REFERENCE: files are versioned in S3, so a replaced document leaves
 * the earlier version at its own key and the reference stays valid. Copying
 * megabytes per run to record something that already cannot change would be
 * storage for nothing.
 */
/** No freeze yet: the step being enqueued will be the one that takes it. */
function noFreezes(t) {
  t.mock.method(models.SubmissionInputFreeze, 'findAll', async () => []);
}

test('the document set is recorded by reference, never copied', async (t) => {
  const { File } = models;
  noFreezes(t);
  t.mock.method(File, 'findOne', async ({ where }) => ({
    id: `${where.type}-id`, fileName: `f.${where.type}`, type: where.type,
    version: 2, s3Key: `key/${where.type}_v2`, size: 4096
  }));

  const docs = await runHistory.captureDocuments('sub-1', 1);

  assert.deepEqual(Object.keys(docs).sort(), ['krt', 'markdown', 'pdf']);
  assert.equal(docs.krt.version, 2, 'the version is what pins the exact file');
  assert.equal(docs.krt.s3Key, 'key/krt_v2');
  assert.ok(!('content' in docs.krt), 'the bytes are not duplicated');
  assert.ok(!('sha256' in docs.krt),
    'and not hashed either — that would mean downloading every file on every enqueue');
});

test('the run records the document the ROUND is reading, not the newest', async (t) => {
  // Once an input is frozen, a step enqueued afterwards reads the frozen file
  // however many versions have been uploaded since. Recording the newest would
  // put a document in the run record that the run never opened — and the module
  // page shows that record beside the result.
  const { File } = models;
  t.mock.method(models.SubmissionInputFreeze, 'findAll', async () => ([
    { inputKind: 'pdf', fileId: 'pdf-v1' }
  ]));
  t.mock.method(File, 'findByPk', async (id) => ({
    id, fileName: 'manuscript.pdf', type: 'pdf', version: 1, s3Key: 'key/pdf_v1', size: 10
  }));
  const latest = t.mock.method(File, 'findOne', async ({ where }) => ({
    id: `${where.type}-id`, fileName: `f.${where.type}`, type: where.type,
    version: 9, s3Key: `key/${where.type}_v9`, size: 4096
  }));

  const docs = await runHistory.captureDocuments('sub-1', 1);

  assert.equal(docs.pdf.version, 1, 'the frozen one');
  assert.equal(docs.markdown.version, 9, 'and the newest for anything not yet frozen');
  assert.equal(latest.mock.callCount(), 2, 'the frozen input is not looked up by type at all');
});

test('a document that does not exist yet is simply absent', async (t) => {
  noFreezes(t);
  // A step that runs before the conversion records no markdown, which is the
  // truth about that run rather than a gap to paper over.
  const { File } = models;
  t.mock.method(File, 'findOne', async ({ where }) => (
    where.type === 'markdown' ? null : { id: 'x', fileName: 'f', type: where.type, version: 1, s3Key: 'k', size: 1 }
  ));

  const docs = await runHistory.captureDocuments('sub-1', 1);

  assert.ok(!('markdown' in docs));
  assert.deepEqual(Object.keys(docs).sort(), ['krt', 'pdf']);
});

test('opening a run records the documents alongside it', async (t) => {
  const state = fakeDb(t);
  noFreezes(t);
  t.mock.method(models.File, 'findOne', async ({ where }) => ({
    id: `${where.type}-id`, fileName: 'f', type: where.type, version: 1, s3Key: 'k', size: 1
  }));

  await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'manual' });

  const written = state.run.updates.find((u) => u.inputs);
  assert.ok(written, 'the run must carry the document set it opened with');
  assert.equal(written.inputs.documents.krt.fileId, 'krt-id');
});

test('a failure to read the documents does not cost us the run record', async (t) => {
  // Order matters: the row is inserted first, because reading the file table is
  // the part most likely to be slow or to fail, and a run without its document
  // set is far better than no run at all.
  const state = fakeDb(t);
  t.mock.method(models.File, 'findOne', async () => { throw new Error('db is on fire'); });

  const run = await runHistory.openRun(JOB, { userId: 'u1' });

  assert.ok(run, 'the run is still opened');
  assert.equal(state.inserted.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Attempts survive a re-delivery
//
// A pg-boss retry is another attempt at the SAME execution, and its ambient
// store starts empty. Writing that over the existing array would erase the
// earlier deliveries — which are the ones worth reading.
// ─────────────────────────────────────────────────────────────────────────────

const attemptLog = require('../../utils/attempt-log');

test('a re-delivery appends to what the first one recorded', () => {
  const run = {
    attempts: [
      { n: 1, layer: 'client', delivery: 1, ok: false, error: 'overloaded' },
      { n: 2, layer: 'queue', delivery: 1, ok: false, error: 'gave up' }
    ]
  };

  const merged = attemptLog.run(() => {
    attemptLog.add({ layer: 'client', engine: 'Gemini', ok: true });
    return runHistory.attemptsWith(run, { ok: true, delivery: 2 });
  });

  assert.equal(merged.length, 4);
  // Renumbered end to end, so `n` is a position in the execution's history
  // rather than a position in whichever delivery happened to write it.
  assert.deepEqual(merged.map((a) => a.n), [1, 2, 3, 4]);
  // Grouped by delivery, which is what makes "retried twice" unambiguous: two
  // layers retry, and the interesting runs are the ones where both did.
  assert.deepEqual(merged.map((a) => a.delivery), [1, 1, 2, 2]);
  assert.deepEqual(merged.map((a) => a.layer), ['client', 'queue', 'client', 'queue']);
});

test('the delivery itself is recorded even when nothing underneath retried', () => {
  // A step that succeeded first time still has one attempt. An empty array
  // would be indistinguishable from a step whose attempts were never captured.
  const merged = attemptLog.run(() => runHistory.attemptsWith({ attempts: null }, { ok: true, delivery: 1 }));

  assert.deepEqual(merged, [{
    at: merged[0].at, layer: 'queue', delivery: 1, ok: true,
    engine: null, error: null, httpStatus: null, n: 1
  }]);
});

test('closing a run writes the attempts alongside the result', async (t) => {
  const state = fakeDb(t, { existingRuns: [1] });

  await attemptLog.run(async () => {
    attemptLog.add({ layer: 'client', engine: 'Softcite', ok: false, error: 'timeout' });
    await runHistory.closeRun({ ...JOB, status: 'failed', errorMessage: 'Softcite unreachable', retryCount: 1 });
  });

  const written = state.run.updates.at(-1);
  assert.equal(written.attempts.length, 2);
  assert.equal(written.attempts[0].engine, 'Softcite');
  assert.equal(written.attempts[1].layer, 'queue');
  assert.equal(written.attempts[1].ok, false);
  // retryCount 1 means this was the SECOND delivery.
  assert.ok(written.attempts.every((a) => a.delivery === 2));
});

// ─────────────────────────────────────────────────────────────────────────────
// A cancel that could not stop the call
//
// The promise is abandoned; the call completes and is billed. Dropping the
// answer silently means the money was spent and the record says nothing.
// ─────────────────────────────────────────────────────────────────────────────

test('a discarded response is recorded with what it cost', async (t) => {
  const state = fakeDb(t);
  const tokenUsage = require('../../utils/token-usage');

  await tokenUsage.run(async () => {
    tokenUsage.add({ promptTokenCount: 30000, candidatesTokenCount: 900, totalTokenCount: 30900 });
    await runHistory.recordDiscarded(JOB, { outcome: 'done', counts: { unique: 4 } });
  });

  const [written] = state.run.updates.at(-1).discarded;
  assert.equal(written.outcome, 'done');
  assert.deepEqual(written.counts, { unique: 4 });
  // The half that makes "did we pay for something we threw away" answerable.
  assert.equal(written.tokens.totalTokens, 30900);
  assert.ok(written.at);
});

test('a second late answer does not erase the first', async (t) => {
  // A retry already in flight when the cancel landed arrives too. Overwriting
  // would under-report exactly the runs worth looking at.
  const state = fakeDb(t);
  state.run.discarded = [{ at: '2026-08-22T10:00:00Z', outcome: 'fail', error: 'first' }];

  await runHistory.recordDiscarded(JOB, { outcome: 'done' });

  assert.equal(state.run.updates.at(-1).discarded.length, 2);
  assert.equal(state.run.updates.at(-1).discarded[0].error, 'first');
});

test('who cancelled is recorded once, and not overwritten', async (t) => {
  // Two people pressing Cancel on the same stalled pipeline must not rewrite
  // the first one's name — the same rule the continue decision follows.
  const state = fakeDb(t);

  await runHistory.recordCancellation(JOB, { userId: 'user-1' });
  const first = state.run.updates.at(-1);
  assert.ok(first.cancelledAt);
  assert.equal(first.cancelledByUserId, 'user-1');

  const before = state.run.updates.length;
  await runHistory.recordCancellation(JOB, { userId: 'user-2' });
  assert.equal(state.run.updates.length, before, 'the second press writes nothing');
});

test('a cancelled execution does not take the answer back as its result', async (t) => {
  // The logger's flush runs from the worker that was interrupted. Without a
  // guard the answer the user threw away comes straight back in as the run's
  // output, and every page renders it as this run's finding — next to a status
  // line saying the run was cancelled.
  const state = fakeDb(t);
  state.run.status = 'cancelled';

  await runHistory.syncRunPayload({
    id: 'job-1',
    result: { counts: { unique: 14 }, data: { items: [1, 2] } },
    logs: [{ step: 'gemini_call' }]
  });

  const written = state.run.updates.at(-1);
  assert.equal(written.result, undefined, 'the discarded answer is not the run\'s result');
  // The log survives: it is the record of what the abandoned call did, and the
  // only place its timing lives.
  assert.deepEqual(written.logs, [{ step: 'gemini_call' }]);
});

test('a normal run still takes its payload', async (t) => {
  const state = fakeDb(t);
  state.run.status = 'complete';

  await runHistory.syncRunPayload({
    id: 'job-1', result: { counts: { unique: 14 } }, logs: [{ step: 'done' }]
  });

  assert.deepEqual(state.run.updates.at(-1).counts, { unique: 14 });
});
