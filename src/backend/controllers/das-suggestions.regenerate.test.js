/**
 * What "re-run the DAS check" answers.
 *
 * Three outcomes, and the difference matters to the reader:
 *
 *   - nothing to check (no statement) — a refusal, and correct;
 *   - accepted, but the step is gated to the Availability step — NOT a refusal,
 *     and not something to poll for either;
 *   - running now.
 *
 * The middle one is why this file exists. The service used to return a bare
 * pg-boss job id, and a gated job has none — so "waiting for the right step"
 * came back indistinguishable from "you have not provided a statement", and the
 * API told authors with a perfectly good statement that they had not written
 * one.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../services/das-suggestions/das-suggestions.service');
const controller = require('./das-suggestions.controller');

/** Run the controller and capture the reply. */
async function call(t, serviceResult) {
  t.mock.method(service, 'queueDasSuggestions', async () => serviceResult);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    controller.regenerate({ params: { id: 'sub-1' }, query: {} }, res, (err) => resolve({ error: err }));
  });
}

test('no statement is reported as nothing to check', async (t) => {
  const { status, body } = await call(t, { queued: false, reason: 'no_statement' });

  assert.equal(status, 200);
  assert.equal(body.queued, false);
  assert.match(body.reason, /no data availability statement/i);
  assert.ok(!body.pending, 'this one really is a refusal — nothing is coming');
});

test('a gated step is reported as accepted, and NOT as a missing statement', async (t) => {
  const { status, body } = await call(t, {
    queued: false, reason: 'gated', status: 'waiting', jobId: null, submissionJobId: 'row-1'
  });

  assert.equal(status, 202, 'accepted, not refused');
  assert.equal(body.pending, true);
  assert.equal(body.status, 'waiting');
  assert.doesNotMatch(body.reason, /no data availability statement/i,
    'the author wrote a statement — saying otherwise is the bug this pins');
  assert.match(body.reason, /availability/i, 'it has to say what it is waiting for');
});

test('a gated step does not claim to be queued', async (t) => {
  // The client polls on `queued`. Claiming it here would spin a loader against
  // a job that is not going to start until the submission moves.
  const { body } = await call(t, { queued: false, reason: 'gated', status: 'waiting' });

  assert.equal(body.queued, false);
  assert.equal(body.jobId, undefined);
});

test('a started step reports its queue id', async (t) => {
  const { status, body } = await call(t, {
    queued: true, reason: null, status: 'queued', jobId: 'pgboss-1', submissionJobId: 'row-1'
  });

  assert.equal(status, 202);
  assert.equal(body.queued, true);
  assert.equal(body.jobId, 'pgboss-1');
});

test('the three outcomes are mutually distinguishable', async (t) => {
  // A client has to be able to branch on the reply alone.
  const outcomes = await Promise.all([
    call(t, { queued: false, reason: 'no_statement' }),
    call(t, { queued: false, reason: 'gated', status: 'waiting' }),
    call(t, { queued: true, reason: null, status: 'queued', jobId: 'pgboss-1' })
  ]);
  const shapes = outcomes.map(({ body }) => `${body.queued}|${!!body.pending}`);

  assert.equal(new Set(shapes).size, 3, `not distinguishable: ${shapes.join(', ')}`);
});
