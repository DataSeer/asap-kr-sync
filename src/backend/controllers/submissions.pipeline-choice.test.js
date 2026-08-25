/**
 * Choosing which detection pipeline analyses a submission.
 *
 * `config/pipelines.js` has defined `seeded-v1` and `blind-v1` since the
 * strategies landed, and `resolveDetection`, `krt-grounding` and
 * `kr-comparison` all read `submission.pipelineId` — but nothing ever stored
 * one. Every submission resolved to the default and `blind-v1` was unreachable:
 * the registry was wired at one end only.
 *
 * Two rules hold it together, and both are tested here.
 *
 *   1. An `adminOnly` pipeline is an experiment arm. It detects differently from
 *      what ships, so a submission created under one is not comparable with the
 *      rest of a corpus, and its output is not what an author should be handed.
 *      Only an admin may name one.
 *
 *   2. It is chosen once, at creation, and never afterwards. The strategies
 *      decide what the detectors are shown, so a mid-flight change would leave
 *      some steps detected blind and some seeded with nothing recording the
 *      split — the fault `submission_input_freezes` exists to prevent for
 *      documents, in a different guise.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-for-signing-anything-real';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../utils/validators');
const { PIPELINES, DEFAULT_PIPELINE_ID, getPipeline } = require('../config/pipelines');
const { Submission } = require('../models');

// ─────────────────────────────────────────────────────────────────────────────
// The column can hold what the registry defines
// ─────────────────────────────────────────────────────────────────────────────

test('every pipeline id fits the column it is stored in', () => {
  // `outcome_source` was STRING(16) and the value written to it was seventeen
  // characters; it failed inside a catch that logged "unaffected" and left every
  // KRT Grounding execution permanently open. The width is read off the model
  // rather than hard-coded so this cannot drift.
  const attr = Submission.getAttributes().pipelineId;
  const max = attr.type.options?.length;

  assert.ok(max, 'pipelineId must be a bounded STRING, not unbounded TEXT');
  for (const id of Object.keys(PIPELINES)) {
    assert.ok(id.length <= max,
      `pipeline id "${id}" is ${id.length} chars, column holds ${max}`);
  }
});

test('the column is nullable, for rows that predate it', () => {
  // Nullable so the migration needs no backfill — inventing an id for rows
  // nobody recorded one for would assert something nothing witnessed. New rows
  // are always stamped; see below.
  const attr = Submission.getAttributes().pipelineId;

  assert.equal(attr.allowNull, true);
  assert.equal(getPipeline(null).id, DEFAULT_PIPELINE_ID,
    'a legacy null must still resolve rather than throw');
  assert.equal(getPipeline(undefined).id, DEFAULT_PIPELINE_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// What the create endpoint accepts
// ─────────────────────────────────────────────────────────────────────────────

test('createSubmission accepts a known pipeline id', () => {
  for (const id of Object.keys(PIPELINES)) {
    const value = validate('createSubmission', { title: 'A manuscript', pipelineId: id });
    assert.equal(value.pipelineId, id);
  }
});

test('createSubmission accepts no pipeline id at all', () => {
  const value = validate('createSubmission', { title: 'A manuscript' });

  assert.equal(value.pipelineId, undefined,
    'omitted must stay omitted — the controller resolves it to the default');
});

test('createSubmission refuses an unknown pipeline id', () => {
  // An unrecognised id must never fall through to the default: the fallback
  // would detect differently and say nothing about it.
  assert.throws(
    () => validate('createSubmission', { title: 'A manuscript', pipelineId: 'seeded-v9' }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('updateSubmission silently drops a pipeline id', () => {
  // Chosen once, at creation. `stripUnknown` is what enforces it, so this test
  // exists to notice if someone adds the field to the update schema.
  const value = validate('updateSubmission', { title: 'Renamed', pipelineId: 'blind-v1' });

  assert.equal(value.pipelineId, undefined);
  assert.equal(value.title, 'Renamed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Who may choose an experiment arm
// ─────────────────────────────────────────────────────────────────────────────

const controller = require('./submissions.controller');

/** Reach the guard through the exported handler, with no file attached. */
async function createAs(user, pipelineId) {
  return new Promise((resolve) => {
    const req = {
      user, userId: user.id, params: {}, body: {},
      validatedBody: { title: 'A manuscript', ...(pipelineId ? { pipelineId } : {}) }
    };
    const res = { status() { return this; }, json: (body) => resolve({ body, error: null }) };
    controller.create(req, res, (error) => resolve({ body: null, error }));
  });
}

test('an admin may choose the admin-only arm', async () => {
  const admin = { id: 'admin-1', role: 'admin' };

  const { error } = await createAs(admin, 'blind-v1');

  // No file is attached, so it fails on the KRT requirement — which is proof it
  // got PAST the pipeline guard. That is the assertion.
  assert.ok(error, 'expected to reach the missing-file check');
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.match(error.message, /Key Resources Table file is required/);
});

for (const role of ['author', 'asap_pm', 'ds_annotator']) {
  test(`a ${role} may not choose the admin-only arm`, async () => {
    const { error } = await createAs({ id: 'u-1', role }, 'blind-v1');

    assert.ok(error);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'AUTHORIZATION_ERROR');
  });
}

test('the refusal happens before the file is parsed', async () => {
  // Refusing after parsing would spend the work and, worse, sits downstream of
  // the point where rows start being created.
  const { error } = await createAs({ id: 'u-1', role: 'author' }, 'blind-v1');

  assert.equal(error.code, 'AUTHORIZATION_ERROR',
    'a missing-file ValidationError here would mean the guard ran too late');
});

test('everyone may create with the default, named or omitted', async () => {
  for (const role of ['author', 'asap_pm', 'ds_annotator', 'admin']) {
    for (const id of [undefined, DEFAULT_PIPELINE_ID]) {
      const { error } = await createAs({ id: 'u-1', role }, id);
      assert.equal(error.code, 'VALIDATION_ERROR',
        `${role} with ${id || 'no id'} must reach the missing-file check, not a 403`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The choice is actually stored
// ─────────────────────────────────────────────────────────────────────────────

const parserService = require('../services/krt/parser.service');
const krtService = require('../services/krt/krt.service');

/**
 * Run create far enough to reach Submission.create and capture what it was
 * given. Everything past the row — the KRT upload, the change log — is stubbed;
 * this is about one field on one payload.
 */
async function capturePayload(t, user, pipelineId) {
  const captured = {};
  t.mock.method(parserService, 'parseFile', async () => [['Resource Type']]);
  t.mock.method(parserService, 'validateColumns', () => ({ valid: true, missingColumns: [] }));
  t.mock.method(Submission, 'create', async (values) => {
    captured.values = values;
    return { id: 'sub-new', ...values, toJSON: () => ({ id: 'sub-new', ...values }) };
  });
  t.mock.method(krtService, 'uploadAndProcess', async () => ({ rowCount: 1 }));

  await new Promise((resolve) => {
    const req = {
      user, userId: user.id, params: {}, body: {},
      file: { buffer: Buffer.from('Resource Type\n'), mimetype: 'text/csv', originalname: 'krt.csv' },
      validatedBody: { title: 'A manuscript', ...(pipelineId ? { pipelineId } : {}) }
    };
    const res = { status() { return this; }, json: () => resolve() };
    controller.create(req, res, () => resolve());
  });

  return captured.values;
}

test('a chosen pipeline is written onto the submission', async (t) => {
  const values = await capturePayload(t, { id: 'admin-1', role: 'admin' }, 'blind-v1');

  assert.equal(values.pipelineId, 'blind-v1',
    'the whole point: the arm must survive onto the row the detectors read');
});

test('choosing nothing still stamps the default explicitly', async (t) => {
  // Never null. `getPipeline(null)` resolves to whatever the default is NOW, so
  // a null row would quietly start claiming a different pipeline the day the
  // default changes. What a submission ran is a fact about the past — the same
  // reasoning that produced frozen prompts and frozen call parameters.
  const values = await capturePayload(t, { id: 'u-1', role: 'author' }, undefined);

  assert.equal(values.pipelineId, DEFAULT_PIPELINE_ID);
  assert.notEqual(values.pipelineId, null);
});

test('a submission never records a pipeline it did not run', async (t) => {
  // The failure this guards: default flips to blind-v1, and every seeded
  // submission ever created starts reporting itself as blind.
  const values = await capturePayload(t, { id: 'u-1', role: 'author' }, undefined);
  const stamped = values.pipelineId;

  assert.ok(Object.keys(PIPELINES).includes(stamped),
    'the stamp must be a real id, resolvable without consulting today\'s default');
});
