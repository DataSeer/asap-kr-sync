'use strict';

/**
 * A typo in the admin jobs URL is a bad request, not a server error.
 *
 * `status` is a Postgres enum and `submissionId` is a uuid, so an unknown
 * value reached the driver and surfaced as
 * `invalid input value for enum enum_submission_jobs_status: "nope"` — a 500
 * carrying the database's own error text to the client, and an admin with no
 * idea which values were valid.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const controller = require('./job-admin.controller');
const jobAdminService = require('../services/queue/job-admin.service');

/**
 * Asserted on `statusCode`/`code` rather than `err.name`: AppError never sets
 * `name`, so every one of these is a plain 'Error' by that measure, and the
 * two fields below are what the error middleware turns into the response.
 */
function assertRejected(error, t) {
  assert.ok(error, 'the request must be rejected');
  assert.equal(error.statusCode, 400, 'a bad filter is the caller\'s mistake, not a server error');
  assert.equal(error.code, 'VALIDATION_ERROR');
}

/** Minimal express doubles: capture whatever the handler produced. */
function run(query, t) {
  const captured = { json: null, error: null };
  t.mock.method(jobAdminService, 'listJobs', async () => ({ jobs: [], counts: {} }));
  const req = { query };
  const res = { json: (body) => { captured.json = body; } };
  const next = (err) => { captured.error = err; };
  return controller.listJobs(req, res, next).then(() => captured);
}

test('a valid filter set reaches the service', async (t) => {
  const { json, error } = await run({ status: 'processing', staleReason: 'any' }, t);
  assert.equal(error, null);
  assert.deepEqual(json, { jobs: [], counts: {} });
});

test('no filters at all is valid', async (t) => {
  const { error } = await run({}, t);
  assert.equal(error, null);
});

test('an unknown status is rejected before it reaches the database', async (t) => {
  const { json, error } = await run({ status: 'nope' }, t);
  assert.equal(json, null, 'nothing may be returned for a rejected request');
  assertRejected(error);
  assert.match(error.message, /nope/);
  assert.match(error.message, /processing/, 'the message must list what would have worked');
});

test('an unknown job type is rejected', async (t) => {
  const { error } = await run({ jobType: 'nope' }, t);
  assertRejected(error);
});

test('an unknown stale reason is rejected, and the keys are the vocabulary', async (t) => {
  const { error } = await run({ staleReason: 'A newer run of the same step exists.' }, t);
  assertRejected(error);   // the sentence is the label, not the token

  const ok = await run({ staleReason: 'superseded' }, t);
  assert.equal(ok.error, null);
});

test('a submission id that is not a uuid is rejected', async (t) => {
  const { error } = await run({ submissionId: 'not-a-uuid' }, t);
  assertRejected(error);
  assert.match(error.message, /submission id/);
});

test('an empty filter string is absence, not a value', async (t) => {
  // The admin page sends `?status=` when its dropdown is cleared.
  const { error } = await run({ status: '', jobType: '', submissionId: '', staleReason: '' }, t);
  assert.equal(error, null);
});
