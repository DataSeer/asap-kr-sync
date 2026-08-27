'use strict';

/**
 * Every try, at both layers, kept.
 *
 * `retryCount: 2` with one overwritten error cannot answer "the first two
 * attempts returned 529, then it succeeded" — which is the difference between
 * an upstream that is flaky and one that is broken.
 *
 * The properties worth pinning are the ones whose failure is SILENT: an
 * accumulator that leaks between concurrent jobs, one that double-records, and
 * one that is unbounded. None of the three would fail a test that merely
 * checked that attempts get recorded.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const attemptLog = require('../utils/attempt-log');

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

test('two 529s and then a success read back as exactly that', async () => {
  const attempts = await attemptLog.run(async () => {
    attemptLog.add({ layer: 'client', engine: 'Gemini', ok: false, error: err('overloaded', { status: 529 }) });
    attemptLog.add({ layer: 'client', engine: 'Gemini', ok: false, error: err('overloaded', { status: 529 }) });
    attemptLog.add({ layer: 'client', engine: 'Gemini', ok: true });
    return attemptLog.drain();
  });

  assert.deepEqual(attempts.map((a) => [a.ok, a.httpStatus]), [
    [false, 529], [false, 529], [true, null]
  ]);
});

test('draining clears, so one delivery cannot be recorded twice', async () => {
  // markRetrying and markFailed can both fire within one delivery. A peek
  // instead of a drain would write the same tries onto the execution twice, and
  // the count is the whole point of the record.
  await attemptLog.run(async () => {
    attemptLog.add({ ok: false, error: 'boom' });
    assert.equal(attemptLog.drain().length, 1);
    assert.deepEqual(attemptLog.drain(), []);
  });
});

test('concurrent jobs cannot see each other\'s attempts', async () => {
  // The reason this is an AsyncLocalStorage and not a module-level array. A
  // shared counter would be wrong only under load, and would look like a flaky
  // upstream rather than a bug.
  const [a, b] = await Promise.all([
    attemptLog.run(async () => {
      attemptLog.add({ engine: 'A', ok: false, error: 'a1' });
      await new Promise((r) => setTimeout(r, 5));
      attemptLog.add({ engine: 'A', ok: true });
      return attemptLog.drain();
    }),
    attemptLog.run(async () => {
      attemptLog.add({ engine: 'B', ok: false, error: 'b1' });
      return attemptLog.drain();
    })
  ]);

  assert.deepEqual(a.map((x) => x.engine), ['A', 'A']);
  assert.deepEqual(b.map((x) => x.engine), ['B']);
});

test('outside a job, recording is a no-op rather than a crash', () => {
  // A script or a test calling the same shared helper is not a run and has
  // nothing to charge. Throwing here would break the helper for every caller.
  assert.doesNotThrow(() => attemptLog.add({ ok: false, error: 'boom' }));
  assert.deepEqual(attemptLog.current(), []);
});

test('the list is bounded', async () => {
  // Written from inside a retry loop. An execution whose record is a megabyte
  // of identical timeouts is unreadable in exactly the situation it was kept
  // for — and being capped is itself a finding.
  await attemptLog.run(async () => {
    for (let i = 0; i < attemptLog.MAX_ATTEMPTS + 50; i += 1) {
      attemptLog.add({ ok: false, error: 'timeout' });
    }
    assert.equal(attemptLog.current().length, attemptLog.MAX_ATTEMPTS);
  });
});

test('a status is found wherever the client happens to put it', () => {
  // Axios, the Google GenAI client and a bare Error all differ, and a status
  // read as null is the difference between "429, back off" and "no idea".
  assert.equal(attemptLog.httpStatusOf(err('nope', { response: { status: 503 } })), 503);
  assert.equal(attemptLog.httpStatusOf(err('nope', { statusCode: 429 })), 429);
  assert.equal(attemptLog.httpStatusOf(err('got status 500 from upstream')), 500);
  assert.equal(attemptLog.httpStatusOf(err('socket hang up')), null);
  // `code` is deliberately not consulted: on a network error it is a string
  // like ECONNRESET, and coercing it yields NaN dressed up as a status.
  assert.equal(attemptLog.httpStatusOf(err('reset', { code: 'ECONNRESET' })), null);
});
