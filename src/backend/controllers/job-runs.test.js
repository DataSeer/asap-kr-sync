'use strict';

/**
 * Reading a past run.
 *
 * Two things are being pinned. First, the shape: a run is returned the way the
 * module page already reads a JOB, so a past run renders through exactly the
 * same path as the current one. Two shapes would mean two rendering branches,
 * and two branches drift.
 *
 * Second, that a mistyped URL is a 400 rather than a 500. The admin jobs
 * endpoint taught that lesson once already — an unknown enum reached the driver
 * and came back as Postgres's own error text.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const controller = require('./jobs.controller');
const { SubmissionJobRun, User } = require('../models');

const RUN = (over = {}) => ({
  jobType: 'identifier_detection',
  round: 1,
  runNumber: 1,
  status: 'complete',
  outcomeState: 'done',
  outcomeSource: 'external',
  failReason: null,
  externalError: null,
  startedAt: new Date('2026-08-22T10:00:00Z'),
  completedAt: new Date('2026-08-22T10:00:02Z'),
  durationMs: 2000,
  retryCount: 0,
  counts: { unique: 12 },
  result: { data: { items: [{ resourceName: 'RRID:AB_1' }] }, files: { scan: 'k' } },
  logs: [{ step: 'start' }],
  inputs: null,
  triggeredByUserId: 'user-1',
  triggerKind: 'manual',
  s3Prefix: 'jobs/identifier_detection/run-1',
  ...over
});

/** Express doubles: capture whatever the handler produced. */
function run(handler, params, t, { runs = [], one = null } = {}) {
  const captured = { json: null, error: null };
  t.mock.method(SubmissionJobRun, 'listForStep', async () => runs);
  t.mock.method(SubmissionJobRun, 'findOne', async () => one);
  t.mock.method(User, 'findByPk', async (id) => ({ id, name: 'Annotator' }));

  const req = { params: { id: 'sub-1', ...params }, query: {}, submission: { currentRound: 1 } };
  const res = { json: (body) => { captured.json = body; } };
  return handler(req, res, (err) => { captured.error = err; }).then(() => captured);
}

const rejected = (error) => {
  assert.ok(error, 'the request must be rejected');
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'VALIDATION_ERROR');
};

test('the run list is newest first, and says which one is current', async (t) => {
  const { json } = await run(controller.listRuns, { jobType: 'identifier_detection' }, t, {
    runs: [RUN({ runNumber: 3 }), RUN({ runNumber: 2 }), RUN({ runNumber: 1 })]
  });

  assert.equal(json.runCount, 3);
  assert.deepEqual(json.runs.map((r) => r.runNumber), [3, 2, 1]);
  assert.deepEqual(json.runs.map((r) => r.isLatest), [true, false, false]);
});

test('the list carries who ran it and how, and omits the payloads', async (t) => {
  const { json } = await run(controller.listRuns, { jobType: 'identifier_detection' }, t, { runs: [RUN()] });

  const [first] = json.runs;
  assert.deepEqual(first.triggeredBy, { id: 'user-1', name: 'Annotator' });
  assert.equal(first.triggerKind, 'manual');
  assert.equal(first.durationMs, 2000);
  // Payloads are megabytes and a list shows none of them.
  assert.equal(first.result, undefined);
  assert.equal(first.logs, undefined);
});

test('a run with no user reports none rather than inventing one', async (t) => {
  const { json } = await run(controller.listRuns, { jobType: 'identifier_detection' }, t, {
    runs: [RUN({ triggeredByUserId: null, triggerKind: 'pipeline' })]
  });

  assert.equal(json.runs[0].triggeredBy, null);
  assert.equal(json.runs[0].triggerKind, 'pipeline');
});

test('one run comes back shaped like a job', async (t) => {
  // The whole point: the module page renders this through the same path it uses
  // for the live job.
  const { json } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '1' }, t, {
    runs: [RUN({ runNumber: 2 }), RUN({ runNumber: 1 })], one: RUN({ runNumber: 1 })
  });

  const r = json.run;
  assert.equal(r.jobType, 'identifier_detection');
  assert.equal(r.status, 'complete');
  assert.ok(r.result.data.items.length, 'the payload is what the tables render from');
  assert.deepEqual(r.triggeredBy, { id: 'user-1', name: 'Annotator' });
  assert.equal(r.elapsedMs, 2000, 'named as the job shape names it');
  assert.equal(r.runCount, 2);
});

test('a run knows whether it is the current one', async (t) => {
  const two = { runs: [RUN({ runNumber: 2 }), RUN({ runNumber: 1 })] };

  const latest = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '2' }, t,
    { ...two, one: RUN({ runNumber: 2 }) });
  assert.equal(latest.json.run.isLatest, true);

  const older = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '1' }, t,
    { ...two, one: RUN({ runNumber: 1 }) });
  assert.equal(older.json.run.isLatest, false, 'the page shows a read-only bar off this');
});

test('an unknown step is a 400, not a query', async (t) => {
  const { json, error } = await run(controller.listRuns, { jobType: 'not_a_step' }, t);
  assert.equal(json, null);
  rejected(error);
  assert.match(error.message, /identifier_detection/, 'the message lists what would have worked');
});

test('a run number that is not a number is a 400', async (t) => {
  for (const bad of ['abc', '0', '-1', '']) {
    const { error } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: bad }, t,
      { runs: [RUN()] });
    rejected(error);
  }
});

test('a run that does not exist is a 404', async (t) => {
  const { error } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '99' }, t,
    { runs: [RUN()], one: null });

  assert.equal(error?.statusCode, 404);
});

test('a step with no runs at all is a 404, not an empty run', async (t) => {
  const { error } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '1' }, t,
    { runs: [], one: null });

  assert.equal(error?.statusCode, 404);
});

/**
 * A past run must not offer another run's artefacts.
 *
 * Artefacts are keyed by run number now, but runs recorded before that shared
 * one folder per job row — the last to write won. An earlier run's links then
 * resolve to a later run's data, which is worse than showing nothing: they look
 * like this run's evidence and are not. The run-scoped prefix is the proof.
 */
test('a run with its own artefact folder says so', async (t) => {
  const { json } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '2' }, t, {
    runs: [RUN({ runNumber: 2 })],
    one: RUN({ runNumber: 2, s3Prefix: 'jobs/identifier_detection/run-2' })
  });

  assert.equal(json.run.artefactsAreOwn, true);
});

test('a run from before artefacts were keyed by run does not', async (t) => {
  const { json } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '1' }, t, {
    runs: [RUN({ runNumber: 2 }), RUN({ runNumber: 1 })],
    // The backfilled shape: keyed by the job row id, shared with every other run
    // of that step.
    one: RUN({ runNumber: 1, s3Prefix: 'jobs/identifier_detection/9b2fca04-4584-41fb-813d-a5e4fadbd709' })
  });

  assert.equal(json.run.artefactsAreOwn, false, 'the page hides its outputs rather than showing a later run\'s');
});

test('a run with no recorded prefix does not either', async (t) => {
  const { json } = await run(controller.getRun, { jobType: 'identifier_detection', runNumber: '1' }, t, {
    runs: [RUN({ runNumber: 1 })], one: RUN({ runNumber: 1, s3Prefix: null })
  });

  assert.equal(json.run.artefactsAreOwn, false);
});
