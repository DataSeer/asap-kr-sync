/**
 * A run's token spend reaching its result.
 *
 * The tally is ambient — the queue opens one per job, every model call
 * underneath adds to it — and this is the seam where it lands on the row. It is
 * done HERE, in `markComplete`, rather than in each of the nine services that
 * call a model, so a service added later reports its usage without knowing any
 * of this exists.
 *
 * Run with: node --test src/backend/models/token-usage-on-result.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob } = require('./index');
const tokenUsage = require('../utils/token-usage');

/**
 * A job row that records what it saved, without a database behind it.
 *
 * A plain object with the real method borrowed onto it, rather than an instance:
 * `Object.create(SubmissionJob.prototype)` looks equivalent but Sequelize's
 * setters need internal state the constructor builds, and assigning to one
 * throws before the test has begun. The method under test only ever touches
 * these few properties.
 */
function fakeJob(t) {
  t.mock.method(require('../services/queue/run-history.service'), 'closeRun', async () => null);
  const job = {
    status: 'processing',
    result: null,
    reload: async () => job,
    save: async () => job,
    changed: () => {},
    markComplete: (r) => SubmissionJob.prototype.markComplete.call(job, r)
  };
  return job;
}

test('what the run spent lands on the result', async (t) => {
  const job = fakeJob(t);

  await tokenUsage.run(async () => {
    tokenUsage.add({ promptTokenCount: 900, candidatesTokenCount: 100, totalTokenCount: 1000 });
    await job.markComplete({ status: { detected: true }, counts: { total: 3 } });
  });

  assert.deepEqual(job.result.tokens, {
    promptTokens: 900, outputTokens: 100, totalTokens: 1000, calls: 1
  });
});

test('it does not displace what the service recorded', async (t) => {
  // The tally is merged INTO the result, not written over it.
  const job = fakeJob(t);

  await tokenUsage.run(async () => {
    tokenUsage.add({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
    await job.markComplete({ status: { detected: true }, counts: { total: 3 }, files: { inputs: 'k' } });
  });

  assert.deepEqual(job.result.counts, { total: 3 });
  assert.deepEqual(job.result.files, { inputs: 'k' });
  assert.equal(job.result.tokens.totalTokens, 15);
});

test('a module that calls no model records no tokens at all', async (t) => {
  // Markdown Convert, ORCID, Softcite-only runs. A row of zeroes would be noise
  // on every page they appear.
  const job = fakeJob(t);

  await tokenUsage.run(async () => {
    await job.markComplete({ status: { detected: true } });
  });

  assert.ok(!('tokens' in job.result), 'no key, rather than a zeroed one');
});

test('a completion outside a job is not charged for anything', async (t) => {
  // markComplete is reachable from places that are not a queue handler. No
  // store means no tally, and that must be silence rather than a crash.
  const job = fakeJob(t);

  await job.markComplete({ status: { detected: true } });

  assert.ok(!('tokens' in job.result));
});

test('a cancelled job records nothing, tokens included', async (t) => {
  // The run was stopped; the result is dropped on purpose, and the spend
  // belongs to the run record rather than to a row the user cancelled.
  const job = fakeJob(t);
  job.status = 'cancelled';

  await tokenUsage.run(async () => {
    tokenUsage.add({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
    await job.markComplete({ status: { detected: true } });
  });

  assert.equal(job.result, null);
});
