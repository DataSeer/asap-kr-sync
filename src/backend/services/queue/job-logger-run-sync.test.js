'use strict';

/**
 * The run's payload has to be copied AFTER the logger has written it.
 *
 * `closeRun` runs from `markComplete`. The job logger's `flush()` runs after
 * that, and it is what writes `result.files` — the S3 keys of every raw
 * response — and `logs`. So the run's copy was taken one step too early, and
 * every run in the database was recorded without its artefacts or its log.
 *
 * Nothing surfaced it: the run existed, carried its status, timings and
 * attribution, and looked complete. Only opening one and finding no outputs
 * showed the gap — which is most of what a past run is worth opening for.
 *
 * This tests the ORDERING, not the copy. A unit test of syncRunPayload passes
 * whether or not anything calls it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createJobLogger } = require('./job-logger.service');
const runHistory = require('./run-history.service');
const s3Service = require('../storage/s3.service');

/** A job row that behaves like the model for the parts flush touches. */
function fakeJob() {
  return {
    id: 'job-1',
    submissionId: 'sub-1',
    jobType: 'software_detection',
    result: { counts: { unique: 3 } },
    logs: null,
    saved: 0,
    async reload() { return this; },
    changed() {},
    async save() { this.saved++; return this; }
  };
}

test('flush hands the completed payload to the run', async (t) => {
  const job = fakeJob();
  const synced = [];
  t.mock.method(runHistory, 'syncRunPayload', async (j) => { synced.push(JSON.parse(JSON.stringify(j.result))); return null; });
  t.mock.method(s3Service, 'uploadFile', async () => ({}));

  const jobLogger = createJobLogger(job, 'MS1', 1);
  jobLogger.log('start', 'off we go');
  await jobLogger.saveRawResponse('gemini-software', { items: [] });
  await jobLogger.flush();

  assert.equal(synced.length, 1, 'the run must be re-synced once flush has saved');
  assert.ok(synced[0].files, 'and it must see the artefact keys flush just wrote');
  assert.ok(synced[0].files['gemini-software'], 'by name');
});

test('the sync happens after the save, not before it', async (t) => {
  // Order is the whole point: syncing first would copy the same incomplete
  // payload closeRun already took.
  const job = fakeJob();
  const order = [];
  job.save = async function () { order.push('save'); return this; };
  t.mock.method(runHistory, 'syncRunPayload', async () => { order.push('sync'); return null; });
  t.mock.method(s3Service, 'uploadFile', async () => ({}));

  const jobLogger = createJobLogger(job, 'MS1', 1);
  await jobLogger.saveRawResponse('r', {});
  await jobLogger.flush();

  assert.deepEqual(order, ['save', 'sync']);
});

test('a run with no artefacts still gets its log', async (t) => {
  const job = fakeJob();
  const synced = [];
  t.mock.method(runHistory, 'syncRunPayload', async (j) => { synced.push(j.logs); return null; });

  const jobLogger = createJobLogger(job, 'MS1', 1);
  jobLogger.log('start', 'nothing was saved to S3');
  await jobLogger.flush();

  assert.equal(synced.length, 1);
  assert.ok(Array.isArray(synced[0]) && synced[0].length > 0, 'the log is part of the payload too');
});

test('a failure to sync never breaks the flush', async (t) => {
  const job = fakeJob();
  t.mock.method(runHistory, 'syncRunPayload', async () => { throw new Error('db is on fire'); });

  const jobLogger = createJobLogger(job, 'MS1', 1);
  jobLogger.log('start', 'x');

  await assert.doesNotReject(() => jobLogger.flush());
});
