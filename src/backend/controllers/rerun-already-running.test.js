/**
 * "Queued" versus "already running", on the re-run endpoints.
 *
 * A re-run asked for while the step is in flight is deliberately a no-op —
 * `requeueStep` returns the in-flight row untouched rather than starting a
 * second run against the same file. The endpoint has to say which of the two
 * happened, or a user waits for a run that is never going to start.
 *
 * The bug this pins was mine, and it was invisible from the code: the decision
 * was read from the status AFTER requeueStep had queued the job, so it always
 * saw `queued` and always answered "already running" — including for a run it
 * had started that instant. It showed up only when a real re-trigger came back
 * "Markdown conversion is already running" for a conversion that had just been
 * queued from `failed`.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob } = require('../models');
const orchestrator = require('../services/queue/orchestrator.service');
const markdownService = require('../services/pdf/markdown-convert.service');
const orcidService = require('../services/orcid/orcid.service');
const markdownController = require('./markdown.controller');
const orcidController = require('./orcid.controller');
const { callController } = require('../test-helpers/fake-transaction');

const SUBMISSION_ID = 'sub-1';

/**
 * `previousStatus` is what the row held BEFORE the re-run; requeueStep always
 * hands back a `queued` row afterwards, which is the whole trap.
 */
function mockOrchestrator(t, previousStatus) {
  t.mock.method(SubmissionJob, 'getLatest', async () => ({ id: 'row-1', status: previousStatus }));
  t.mock.method(orchestrator, 'cascadeRestart', async () => []);
  t.mock.method(orchestrator, 'requeueStep', async () => ({ id: 'row-1', status: 'queued' }));
}

const request = () => ({
  submission: { id: SUBMISSION_ID, currentRound: 1 },
  userId: 'user-1'
});

// ─────────────────────────────────────────────────────────────────────────────

test('a step re-run from failed reports that it was queued', async (t) => {
  mockOrchestrator(t, 'failed');

  const { body } = await callController(markdownController.triggerConvert, request());

  assert.match(body.message, /queued/i);
  assert.doesNotMatch(body.message, /already running/i, 'it was not running — it had failed');
});

test('a step re-run from complete reports that it was queued', async (t) => {
  mockOrchestrator(t, 'complete');

  const { body } = await callController(markdownController.triggerConvert, request());

  assert.match(body.message, /queued/i);
  assert.doesNotMatch(body.message, /already running/i);
});

test('a step that IS in flight reports that, and does not promise a new run', async (t) => {
  for (const status of ['queued', 'processing']) {
    mockOrchestrator(t, status);

    const { body } = await callController(markdownController.triggerConvert, request());

    assert.match(body.message, /already running/i, `a ${status} step is already going`);
    t.mock.restoreAll();
  }
});

test('the same distinction holds for author extraction', async (t) => {
  mockOrchestrator(t, 'failed');
  const queued = await callController(orcidController.triggerExtraction, request());
  assert.doesNotMatch(queued.body.message, /already running/i);

  t.mock.restoreAll();
  mockOrchestrator(t, 'processing');
  const running = await callController(orcidController.triggerExtraction, request());
  assert.match(running.body.message, /already running/i);
});

test('the service reports the distinction, not just the endpoint', async (t) => {
  // Kept at the service boundary so a second caller cannot re-derive it wrongly
  // from a status requeueStep has already changed.
  mockOrchestrator(t, 'processing');

  const result = await markdownService.queueMarkdownConvert(SUBMISSION_ID, 1, 'user-1');

  assert.equal(result.alreadyInFlight, true);
  assert.ok(result.job, 'and the row still comes back');
});

test('a step with no row yet is a fresh queue, not "already running"', async (t) => {
  t.mock.method(SubmissionJob, 'getLatest', async () => null);
  t.mock.method(orchestrator, 'cascadeRestart', async () => []);
  t.mock.method(orchestrator, 'requeueStep', async () => ({ id: 'row-1', status: 'queued' }));

  const { body } = await callController(markdownController.triggerConvert, request());

  assert.doesNotMatch(body.message, /already running/i);
});
