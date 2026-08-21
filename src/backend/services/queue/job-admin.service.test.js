/**
 * Tests for the job-admin staleness classifier.
 *
 * This is the logic that decides what an operator is offered for deletion, so
 * the invariants worth pinning are the conservative ones: a healthy job is
 * never marked stale, a finished job is history rather than backlog, and a
 * running job is never swept up.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyJob,
  buildStats,
  STALE_REASONS,
  STUCK_WAITING_HOURS,
  STALE_ACTIVE_HOURS
} = require('./job-admin.service');

const NOW = 1_700_000_000_000;
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

const job = (over = {}) => ({
  id: 'job-1',
  submissionId: 'sub-1',
  jobType: 'materials_detection',
  round: 1,
  status: 'waiting',
  createdAt: hoursAgo(1),
  updatedAt: hoursAgo(1),
  ...over
});

/** Newest-per-key map where the given job IS the newest. */
const newestFor = (j) => new Map([[`${j.submissionId}|${j.jobType}|${j.round}`, j.id]]);

test('a recent waiting job is healthy', () => {
  const j = job();
  assert.equal(classifyJob(j, true, newestFor(j), NOW), null);
});

test('a job whose submission is gone is orphaned', () => {
  const j = job();
  assert.equal(classifyJob(j, false, newestFor(j), NOW), 'orphaned');
});

test('orphaned wins over every other verdict', () => {
  const j = job({ status: 'complete' });
  // Even a finished job is worth removing once its submission is gone.
  assert.equal(classifyJob(j, false, newestFor(j), NOW), 'orphaned');
});

test('an older run of the same step is superseded', () => {
  const older = job({ id: 'old' });
  const newest = new Map([[`${older.submissionId}|${older.jobType}|${older.round}`, 'newer-id']]);
  assert.equal(classifyJob(older, true, newest, NOW), 'superseded');
});

test('a different round is not superseded by another round', () => {
  const r2 = job({ id: 'r2', round: 2 });
  const newest = new Map([
    ['sub-1|materials_detection|1', 'r1'],
    ['sub-1|materials_detection|2', 'r2']
  ]);
  assert.equal(classifyJob(r2, true, newest, NOW), null);
});

test('a long-waiting job is stuck', () => {
  const j = job({ updatedAt: hoursAgo(STUCK_WAITING_HOURS + 1) });
  assert.equal(classifyJob(j, true, newestFor(j), NOW), 'stuck_waiting');
});

test('a job waiting just under the threshold is still healthy', () => {
  const j = job({ updatedAt: hoursAgo(STUCK_WAITING_HOURS - 1) });
  assert.equal(classifyJob(j, true, newestFor(j), NOW), null);
});

test('a long-running or long-queued job is stale_active', () => {
  for (const status of ['queued', 'processing']) {
    const j = job({ status, updatedAt: hoursAgo(STALE_ACTIVE_HOURS + 1) });
    assert.equal(classifyJob(j, true, newestFor(j), NOW), 'stale_active', status);
  }
});

test('a job that just started processing is healthy', () => {
  const j = job({ status: 'processing', updatedAt: hoursAgo(0.1) });
  assert.equal(classifyJob(j, true, newestFor(j), NOW), null);
});

test('finished jobs are history, never stale, however old', () => {
  for (const status of ['complete', 'failed', 'cancelled']) {
    const j = job({ status, updatedAt: hoursAgo(10_000) });
    assert.equal(classifyJob(j, true, newestFor(j), NOW), null, status);
  }
});

test('falls back to createdAt when updatedAt is absent', () => {
  const j = job({ updatedAt: null, createdAt: hoursAgo(STUCK_WAITING_HOURS + 1) });
  assert.equal(classifyJob(j, true, newestFor(j), NOW), 'stuck_waiting');
});

test('every reason the classifier can return has a description', () => {
  const produced = ['orphaned', 'superseded', 'stuck_waiting', 'stale_active'];
  for (const reason of produced) {
    assert.ok(STALE_REASONS[reason], `${reason} needs a description for the UI`);
  }
});

test('buildStats counts statuses, staleness and running jobs', () => {
  const stats = buildStats([
    { status: 'waiting', staleReason: 'stuck_waiting' },
    { status: 'waiting', staleReason: null },
    { status: 'processing', staleReason: null },
    { status: 'failed', staleReason: 'orphaned' }
  ]);
  assert.equal(stats.total, 4);
  assert.equal(stats.stale, 2);
  assert.equal(stats.running, 1);
  assert.deepEqual(stats.byStatus, { waiting: 2, processing: 1, failed: 1 });
  assert.deepEqual(stats.byStaleReason, { stuck_waiting: 1, orphaned: 1 });
});
