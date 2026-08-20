/**
 * Rows that claim to be running when nothing is.
 *
 * A worker writes `processing` when it picks a job up, and something has to
 * write the end. Usually the handler does — it completes, or it throws. But a
 * job that EXPIRES never reaches the handler: pg-boss times it out, and once
 * the retries are spent it stops redelivering. Nothing updates our row, which
 * then sits at `processing` for ever — a spinner that never resolves,
 * `isAnyRunning` permanently true, the Continue gate held shut.
 *
 * Found on a real run: a conversion whose queue entry pg-boss had marked
 * `expired` 20 minutes earlier was still `processing`, with its dependents
 * waiting behind it.
 *
 * pg-boss's own table is the authority here, so these tests are about asking it
 * rather than guessing from elapsed time — a long job is not a dead one.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, SubmissionJob } = require('../../models');
const orchestrator = require('./orchestrator.service');

const OLD = new Date('2026-08-20T10:00:00Z');

function row(over = {}) {
  const r = {
    id: 'job-1',
    submissionId: 'sub-1',
    round: 1,
    jobType: 'markdown_convert',
    status: 'processing',
    pgBossJobId: 'pgboss-1',
    startedAt: OLD,
    errorMessage: null,
    completedAt: null,
    ...over
  };
  r.markFailed = SubmissionJob.prototype.markFailed.bind(r);
  r.save = async () => r;
  return r;
}

/** Point the model and the pg-boss lookup at fixtures. */
function mock(t, rows, queueState) {
  t.mock.method(SubmissionJob, 'findAll', async () => rows);
  t.mock.method(sequelize, 'query', async () => [queueState === null ? [] : [{ state: queueState }]]);
}

test('a row whose queue entry expired is failed', async (t) => {
  const stranded = row();
  mock(t, [stranded], 'expired');

  const failed = await orchestrator.failStrandedProcessingJobs(new Date());

  assert.equal(failed, 1);
  assert.equal(stranded.status, 'failed');
  assert.match(stranded.errorMessage, /without recording a result/);
});

test('a row whose queue entry is gone entirely is failed', async (t) => {
  // pg-boss archives finished jobs out of `job`, so absent means finished —
  // never "still running".
  const stranded = row();
  mock(t, [stranded], null);

  assert.equal(await orchestrator.failStrandedProcessingJobs(new Date()), 1);
  assert.equal(stranded.status, 'failed');
});

test('a row with no queue id at all is failed', async (t) => {
  const stranded = row({ pgBossJobId: null });
  mock(t, [stranded], 'active');

  assert.equal(await orchestrator.failStrandedProcessingJobs(new Date()), 1);
});

test('a job that is genuinely running is left alone', async (t) => {
  // The property that stops this being destructive. A long job is not a dead
  // one — conversion legitimately takes minutes.
  for (const state of ['active', 'created', 'retry']) {
    const running = row();
    mock(t, [running], state);

    assert.equal(await orchestrator.failStrandedProcessingJobs(new Date()), 0, state);
    assert.equal(running.status, 'processing', `a ${state} job must not be touched`);
  }
});

test('nothing to sweep is not an error', async (t) => {
  mock(t, [], 'expired');
  assert.equal(await orchestrator.failStrandedProcessingJobs(new Date()), 0);
});

test('a cancelled row is never resurrected into failed', async (t) => {
  // markFailed's own guard. A user cancel outranks a sweep.
  const cancelled = row({ status: 'cancelled' });
  mock(t, [cancelled], 'expired');

  await orchestrator.failStrandedProcessingJobs(new Date());

  assert.equal(cancelled.status, 'cancelled');
});
