/**
 * What `{ concurrency: N }` on a worker actually asks pg-boss for.
 *
 * pg-boss splits the idea in two: `teamSize` is how many jobs are fetched,
 * `teamConcurrency` is how many of them run at once. Setting only the first
 * gives you a worker that fetches N jobs and then works through them one at a
 * time — a concurrency setting that reads as if it does something and does
 * nothing. Every worker in workers.js declares `concurrency`, half of them 2,
 * and none of it had any effect.
 *
 * `concurrency` is this codebase's name for the pair, not a pg-boss option, so
 * it must not be passed through either.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildWorkerOptions } = require('./job-queue.service');

test('concurrency sets how many jobs actually run at once, not just how many are fetched', () => {
  const options = buildWorkerOptions({ concurrency: 2 });

  assert.equal(options.teamSize, 2, 'two jobs fetched');
  assert.equal(options.teamConcurrency, 2, 'and two of them running — this was pinned at 1');
});

test('the default is one at a time', () => {
  const options = buildWorkerOptions({});

  assert.equal(options.teamSize, 1);
  assert.equal(options.teamConcurrency, 1);
});

test('an explicit teamConcurrency still wins', () => {
  // Fetch a batch, run fewer of them: a legitimate combination for a worker
  // whose jobs are cheap to hold but expensive to run.
  const options = buildWorkerOptions({ concurrency: 4, teamConcurrency: 2 });

  assert.equal(options.teamSize, 4);
  assert.equal(options.teamConcurrency, 2);
});

test('`concurrency` is not forwarded to pg-boss — it is not one of its options', () => {
  const options = buildWorkerOptions({ concurrency: 2 });

  assert.equal(options.concurrency, undefined);
});

test('retry metadata stays on, or the UI attempt counter sticks at 1/3', () => {
  const options = buildWorkerOptions({ concurrency: 2 });

  assert.equal(options.includeMetadata, true);
});
