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
  const state = { inserted: [], updatedJob: null, run: null };

  t.mock.method(models.sequelize, 'query', async (sql, opts) => {
    assert.match(sql, /INSERT INTO "submission_job_runs"/, 'openRun must insert');
    // The allocation happens in SQL — COALESCE(MAX(run_number),0)+1 — so two
    // callers cannot read the same maximum. Modelled here.
    const next = existingRuns.length + 1;
    existingRuns.push(next);
    state.inserted.push({ ...opts.replacements, run_number: next });
    return [[{ id: `run-${next}`, run_number: next }]];
  });

  t.mock.method(models.SubmissionJob, 'update', async (values, where) => {
    state.updatedJob = { values, where };
    return [1];
  });

  state.run = {
    runNumber: existingRuns.length || 1,
    updates: [],
    async update(fields) { this.updates.push(fields); Object.assign(this, fields); return this; }
  };
  t.mock.method(models.SubmissionJobRun, 'findByPk', async () => state.run);
  t.mock.method(models.SubmissionJobRun, 'findOne', async () => state.run);

  return state;
}

test('opening a run numbers it 1, then 2, then 3', async (t) => {
  const state = fakeDb(t);

  await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'manual' });
  await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'manual' });
  await runHistory.openRun(JOB, { userId: 'u1', triggerKind: 'pipeline' });

  assert.deepEqual(state.inserted.map((i) => i.run_number), [1, 2, 3]);
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

test('opening a run bumps the job row\'s run_count', async (t) => {
  // Denormalised so the panel can say "run 3" without an aggregate on a table
  // polled every few seconds.
  const state = fakeDb(t);

  await runHistory.openRun(JOB, {});
  await runHistory.openRun(JOB, {});

  assert.deepEqual(state.updatedJob.values, { runCount: 2 });
  assert.deepEqual(state.updatedJob.where, { where: { id: 'job-1' } });
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
  t.mock.method(models.SubmissionJobRun, 'findOne', async () => { throw new Error('db is on fire'); });

  await assert.doesNotReject(() => runHistory.openRun(JOB, { userId: 'u1' }));
  await assert.doesNotReject(() => runHistory.closeRun(JOB));
  await assert.doesNotReject(() => runHistory.touchRun(JOB, { retryCount: 1 }));

  assert.equal(await runHistory.openRun(JOB, {}), null, 'and it reports the failure as null');
});

test('closing a run that was never opened is a no-op, not a crash', async (t) => {
  t.mock.method(models.SubmissionJobRun, 'findOne', async () => null);

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
  const { SubmissionJob, SubmissionJobRun, File, ChangeLog } = models;

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
    ['jobType', 'job_type'], ['runNumber', 'run_number'],
    ['outcomeState', 'outcome_state'], ['outcomeSource', 'outcome_source'],
    ['failReason', 'fail_reason'], ['externalError', 'external_error'],
    ['triggeredByUserId', 'triggered_by_user_id'], ['triggerKind', 'trigger_kind'],
    ['startedAt', 'started_at'], ['completedAt', 'completed_at'],
    ['durationMs', 'duration_ms'], ['retryCount', 'retry_count'],
    ['s3Prefix', 's3_prefix']
  ]) has(SubmissionJobRun, attr, column);
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
test('the document set is recorded by reference, never copied', async (t) => {
  const { File } = models;
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

test('a document that does not exist yet is simply absent', async (t) => {
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
