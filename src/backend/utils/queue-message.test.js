'use strict';

/**
 * What the user is told after asking for a re-run.
 *
 * Every one of these endpoints used to answer "<step> queued" whenever the
 * call did not throw. `requeueStep` enqueues only a step that can run now, so
 * "queued" was a guess that happened to be right about half the time — and
 * when it was wrong the user waited on a step the pipeline had deliberately
 * parked.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describeQueueOutcome } = require('./queue-message');

const L = 'Materials detection';

test('a step that was enqueued says so', () => {
  assert.equal(describeQueueOutcome(L, { status: 'queued' }), 'Materials detection queued');
});

test('a step already in flight is never reported as a new run', () => {
  assert.equal(describeQueueOutcome(L, { status: 'queued' }, true), 'Materials detection is already running');
  assert.equal(describeQueueOutcome(L, { status: 'processing' }), 'Materials detection is already running');
});

test('a gated step says it is waiting, not that it started', () => {
  const message = describeQueueOutcome(L, { status: 'waiting' });
  assert.match(message, /will start once/);
  assert.doesNotMatch(message, /queued/,
    'the whole point is that this is NOT the queued sentence');
});

test('a step needing input says so', () => {
  assert.match(describeQueueOutcome(L, { status: 'pending_input' }), /needs input/);
});

test('a step killed by a cancelled dependency does not claim to be running', () => {
  const message = describeQueueOutcome(L, { status: 'cancelled' });
  assert.match(message, /cannot run/);
  assert.doesNotMatch(message, /queued|running/);
});

test('an unexpected status does not invent a state', () => {
  for (const job of [{ status: 'complete' }, {}, null, undefined]) {
    const message = describeQueueOutcome(L, job);
    assert.equal(message, 'Materials detection requested');
  }
});
