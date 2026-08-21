/**
 * Confirming the Availability Statement.
 *
 * The Availability check is the only step that will not start on its own. It
 * reports on a paragraph pulled out of the manuscript automatically, and
 * extraction gets it wrong often enough to matter — a check of the wrong
 * paragraph is worse than no check, because it goes into the report as the
 * author's own statement.
 *
 * So confirming is a decision: recorded with who made it and when, and it is
 * what authorises the spend.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob } = require('../models');
const orchestrator = require('../services/queue/orchestrator.service');
const controller = require('./submissions.controller');
const { JOB_TYPES } = require('../config/constants');

const NOW_ISH = (value) => value instanceof Date && !Number.isNaN(value.getTime());

/**
 * Run confirmDas against a fake submission and capture what happened.
 * `jobStatus` is the state of the existing das_suggestions row (null = none).
 */
async function confirm(t, { das, jobStatus = 'pending_input', userId = 'user-9', releasedAs = 'queued' } = {}) {
  const saved = [];
  const submission = {
    id: 'sub-1',
    currentRound: 2,
    dataAvailabilityStatement: das,
    dasConfirmedAt: null,
    dasConfirmedByUserId: null,
    save: async function () { saved.push({ at: this.dasConfirmedAt, by: this.dasConfirmedByUserId }); }
  };

  t.mock.method(SubmissionJob, 'getLatest', async () => (jobStatus ? { status: jobStatus } : null));
  const requeued = [];
  t.mock.method(orchestrator, 'requeueStep', async (...args) => {
    requeued.push(args);
    return { status: releasedAs };
  });

  const reply = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    controller.confirmDas({ submission, userId, params: { id: 'sub-1' } }, res,
      (err) => resolve({ error: err }));
  });

  return { ...reply, submission, saved, requeued };
}

test('confirming records who agreed, and when', async (t) => {
  const { body, submission, error } = await confirm(t, { das: 'Data are at Zenodo.' });

  assert.equal(error, undefined);
  assert.ok(NOW_ISH(submission.dasConfirmedAt), 'the moment of the decision is stored');
  assert.equal(submission.dasConfirmedByUserId, 'user-9', 'and the person who made it');
  assert.equal(body.dasConfirmedByUserId, 'user-9');
});

test('confirming releases the check, credited to the confirmer', async (t) => {
  const { requeued } = await confirm(t, { das: 'Data are at Zenodo.' });

  assert.equal(requeued.length, 1, 'pending_input is a dead end — something has to reset it');
  const [submissionId, jobType, round, userId] = requeued[0];
  assert.equal(submissionId, 'sub-1');
  assert.equal(jobType, JOB_TYPES.DAS_SUGGESTIONS);
  assert.equal(round, 2, 'the round it was confirmed for, not round 1');
  assert.equal(userId, 'user-9', 'they authorised this run, so it is theirs');
});

test('there is nothing to confirm when no statement exists', async (t) => {
  const { error, requeued } = await confirm(t, { das: '   ' });

  assert.ok(error, 'confirming nothing is not a decision');
  assert.match(error.message, /no availability statement/i);
  assert.equal(requeued.length, 0);
});

test('"Not found" is not a statement', async (t) => {
  // Extraction is fail-soft and always persists something; the sentinel IS the
  // empty case. Confirming it would send the checker the literal words to
  // review, and bill for the privilege.
  const { error, requeued } = await confirm(t, { das: 'Not found' });

  assert.ok(error);
  assert.equal(requeued.length, 0);
});

test('a check that already ran is not re-run by confirming again', async (t) => {
  // Someone reopening the confirmation screen and clicking again must not spend
  // a second call. requeueStep would happily reset a `complete` row.
  const { requeued, submission } = await confirm(t, { das: 'Data are at Zenodo.', jobStatus: 'complete' });

  assert.equal(requeued.length, 0, 'nothing to release');
  assert.ok(NOW_ISH(submission.dasConfirmedAt), 'but the confirmation is still recorded');
});

test('nor is one that is running right now', async (t) => {
  for (const jobStatus of ['queued', 'processing']) {
    const { requeued } = await confirm(t, { das: 'Data are at Zenodo.', jobStatus });
    assert.equal(requeued.length, 0, `${jobStatus} is already on its way`);
    t.mock.restoreAll();
  }
});

test('a failed check IS retried by a fresh confirmation', async (t) => {
  const { requeued } = await confirm(t, { das: 'Data are at Zenodo.', jobStatus: 'failed' });

  assert.equal(requeued.length, 1);
});

test('with no row at all, the step is still released', async (t) => {
  // A submission whose pipeline never seeded the row — confirming must not
  // silently do nothing.
  const { requeued } = await confirm(t, { das: 'Data are at Zenodo.', jobStatus: null });

  assert.equal(requeued.length, 1);
});

test('a release that fails does not fail the confirmation', async (t) => {
  // The confirmation is recorded either way, and the reconciler picks the step
  // up within a sweep. Telling the user their confirmation did not land would
  // be false, and they would click again.
  const submission = {
    id: 'sub-1', currentRound: 1,
    dataAvailabilityStatement: 'Data are at Zenodo.',
    dasConfirmedAt: null, dasConfirmedByUserId: null,
    save: async () => {}
  };
  t.mock.method(SubmissionJob, 'getLatest', async () => ({ status: 'pending_input' }));
  t.mock.method(orchestrator, 'requeueStep', async () => { throw new Error('queue is down'); });

  const reply = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    controller.confirmDas({ submission, userId: 'user-9', params: { id: 'sub-1' } }, res,
      (err) => resolve({ error: err }));
  });

  assert.equal(reply.error, undefined, 'the user confirmed; that part worked');
  assert.ok(NOW_ISH(submission.dasConfirmedAt));
});

// ─────────────────────────────────────────────────────────────────────────────
// Saying only what actually happened
//
// The reply drives a message the user reads and a poller they wait on. "We are
// checking it now" over a check that is not running sends them to watch a
// spinner that will never resolve, and there is no way for them to find out.
// ─────────────────────────────────────────────────────────────────────────────

test('a check that starts is reported as running', async (t) => {
  const { body } = await confirm(t, { das: 'Data are at Zenodo.', releasedAs: 'queued' });

  assert.equal(body.checking, true);
});

test('a check gated to a later step is NOT reported as running', async (t) => {
  // `waiting` means accepted but held — the submission has not reached the
  // Availability step yet. Nothing is happening, and nothing is coming until
  // the author gets there.
  const { body } = await confirm(t, { das: 'Data are at Zenodo.', releasedAs: 'waiting' });

  assert.equal(body.checking, false);
});

test('a check that already ran is not reported as running', async (t) => {
  const { body } = await confirm(t, { das: 'Data are at Zenodo.', jobStatus: 'complete' });

  assert.equal(body.checking, false);
  assert.ok(body.dasConfirmedAt, 'the confirmation still stands');
});

test('a release that failed is not reported as running', async (t) => {
  const submission = {
    id: 'sub-1', currentRound: 1,
    dataAvailabilityStatement: 'Data are at Zenodo.',
    dasConfirmedAt: null, dasConfirmedByUserId: null,
    save: async () => {}
  };
  t.mock.method(SubmissionJob, 'getLatest', async () => ({ status: 'pending_input' }));
  t.mock.method(orchestrator, 'requeueStep', async () => { throw new Error('queue is down'); });

  const { body } = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); }
    };
    controller.confirmDas({ submission, userId: 'user-9', params: { id: 'sub-1' } }, res,
      (err) => resolve({ error: err }));
  });

  assert.equal(body.checking, false, 'the confirmation landed; the run did not');
  assert.ok(body.dasConfirmedAt);
});

// ─────────────────────────────────────────────────────────────────────────────
// Writing the statement IS confirming it
//
// The confirmation exists because extraction writes this field automatically.
// A person who types the statement has already vouched for it; making them
// click "confirm" on their own sentence is the kind of dialog people learn to
// dismiss without reading, which is worse than not asking.
// ─────────────────────────────────────────────────────────────────────────────

/** Run `update` with a DAS change and capture what it did. */
async function saveStatement(t, { from, to, userId = 'user-9', jobStatus = 'pending_input' } = {}) {
  const submission = {
    id: 'sub-1',
    currentRound: 1,
    status: 'step_as',
    dataAvailabilityStatement: from,
    dasConfirmedAt: null,
    dasConfirmedByUserId: null,
    canTransitionTo: () => true,
    save: async () => {},
    toJSON() { return { id: this.id }; }
  };
  t.mock.method(SubmissionJob, 'getLatest', async () => (jobStatus ? { status: jobStatus } : null));
  const requeued = [];
  t.mock.method(orchestrator, 'requeueStep', async (...args) => { requeued.push(args); return {}; });

  const reply = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    controller.update(
      { submission, userId, params: { id: 'sub-1' }, validatedBody: { dataAvailabilityStatement: to } },
      res,
      (err) => resolve({ error: err })
    );
  });

  return { ...reply, submission, requeued };
}

test('typing a statement confirms it, in the author\'s name', async (t) => {
  const { submission, error } = await saveStatement(t, { from: 'Not found', to: 'All data are in the supplement.' });

  assert.equal(error, undefined);
  assert.ok(NOW_ISH(submission.dasConfirmedAt));
  assert.equal(submission.dasConfirmedByUserId, 'user-9');
});

test('and releases the check, so the author sees something happen', async (t) => {
  const { requeued } = await saveStatement(t, { from: 'Not found', to: 'All data are in the supplement.' });

  assert.equal(requeued.length, 1,
    'without this the author writes the statement and the pipeline just sits there');
});

test('re-saving the same text does not re-stamp the confirmation', async (t) => {
  // The metadata modal saves every field on every save. Treating an unchanged
  // statement as a fresh decision would credit whoever last touched the form
  // with a decision somebody else made.
  const { submission, requeued } = await saveStatement(t, { from: 'Data are at Zenodo.', to: 'Data are at Zenodo.' });

  assert.equal(submission.dasConfirmedAt, null, 'nothing changed, so nothing was decided');
  assert.equal(requeued.length, 0);
});

test('clearing the statement clears the confirmation', async (t) => {
  // Emptying the field is not authorship. A confirmation left standing over a
  // blank statement would let the check run the moment any text reappeared —
  // including text the extractor wrote.
  for (const blank of ['', '   ', null]) {
    const { submission, requeued } = await saveStatement(t, { from: 'Data are at Zenodo.', to: blank });

    assert.equal(submission.dasConfirmedAt, null, `${JSON.stringify(blank)} confirms nothing`);
    assert.equal(requeued.length, 0);
    t.mock.restoreAll();
  }
});

test('saving the sentinel is not a confirmation either', async (t) => {
  // "Not found" is what extraction persists when it found nothing. Round-trip
  // it through the form and it is still nothing.
  const { submission } = await saveStatement(t, { from: 'Data are at Zenodo.', to: 'Not found' });

  assert.equal(submission.dasConfirmedAt, null);
});
