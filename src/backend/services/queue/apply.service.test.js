'use strict';

/**
 * Promoting a pipeline result into the submission.
 *
 * The property under test is not "does the value land" — it is that landing is
 * a DECIDED, RECORDED act. Three steps used to write submission state directly
 * and nothing said they had, which meant a run was not a snapshot (open run 1,
 * read run 2's statement) and could not be re-executed without side effects.
 *
 * So each test asserts on both halves: what the submission holds afterwards,
 * and what the change log says about how it got there.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const { applyToSubmission, TARGETS } = require('./apply.service');

/** Capture change-log rows instead of writing them. */
function captureApplies(t) {
  const written = [];
  t.mock.method(models.ChangeLog, 'create', async (row) => {
    written.push(row);
    return { id: `log-${written.length}`, ...row };
  });
  return written;
}

const submissionWith = (over = {}) => ({
  id: 'sub-1',
  currentRound: 1,
  dataAvailabilityStatement: null,
  dasConfirmedAt: null,
  dasConfirmedByUserId: null,
  authors: null,
  saves: 0,
  async save() { this.saves += 1; return this; },
  ...over
});

test('an unknown target is refused rather than guessed at', async () => {
  // The list of what may be promoted is deliberately closed. A typo that
  // silently wrote nothing would look exactly like a rule declining to fire.
  await assert.rejects(
    () => applyToSubmission({ submission: submissionWith(), target: 'status', value: 'done' }),
    /Nothing may be applied to "status"/
  );
});

test('authors are applied, and the row says which run found them', async (t) => {
  const applies = captureApplies(t);
  const submission = submissionWith();

  const result = await applyToSubmission({
    submission,
    target: 'authors',
    value: { items: [{ lastName: 'Curie' }], meta: { engine: 'grobid' } },
    stepExecutionId: 'exec-3'
  });

  assert.equal(result.applied, true);
  assert.deepEqual(submission.authors.items, [{ lastName: 'Curie' }]);
  assert.equal(applies[0].stepExecutionId, 'exec-3');
  assert.equal(applies[0].columnName, 'authors');
  assert.equal(applies[0].source, 'pipeline');
});

test('an empty author list is refused, so an outage cannot wipe a good one', async (t) => {
  // `fail` resolves rather than throwing, with items: [] — which is how a
  // GROBID outage on the final attempt used to replace a real author list with
  // nothing at all.
  const applies = captureApplies(t);
  const submission = submissionWith({ authors: { items: [{ lastName: 'Curie' }] } });

  const result = await applyToSubmission({
    submission, target: 'authors', value: { items: [], meta: {} }
  });

  assert.equal(result.applied, false);
  assert.match(result.reason, /no authors/);
  assert.deepEqual(submission.authors.items, [{ lastName: 'Curie' }]);
  assert.deepEqual(applies, [], 'nothing changed, so nothing is logged');
  assert.equal(submission.saves, 0, 'and nothing is written');
});

test('a person accepting a value is credited; the pipeline is not', async (t) => {
  const applies = captureApplies(t);

  await applyToSubmission({
    submission: submissionWith(),
    target: 'data_availability_statement',
    value: 'Data are at Zenodo.',
    stepExecutionId: 'exec-1',
    userId: 'user-9'
  });
  assert.equal(applies[0].userId, 'user-9');
  assert.equal(applies[0].source, 'manual');

  await applyToSubmission({
    submission: submissionWith(),
    target: 'data_availability_statement',
    value: 'Data are at Zenodo.',
    stepExecutionId: 'exec-1'
  });
  assert.equal(applies[1].userId, null);
  assert.equal(applies[1].source, 'pipeline');
});

test('a promoted statement carries no confirmation with it', async (t) => {
  // Extractor-authored text has nobody behind it. A confirmation left from
  // earlier words would make the Availability check report on a statement
  // nobody has read, in the author's name.
  captureApplies(t);
  const submission = submissionWith({
    dataAvailabilityStatement: '',
    dasConfirmedAt: new Date('2026-08-20T09:00:00Z'),
    dasConfirmedByUserId: 'user-1'
  });

  await applyToSubmission({
    submission, target: 'data_availability_statement', value: 'Data are at Zenodo.'
  });

  assert.equal(submission.dasConfirmedAt, null);
  assert.equal(submission.dasConfirmedByUserId, null);
});

test('a value identical to what is there is not re-applied', async (t) => {
  // Otherwise every re-extraction of an unchanged manuscript writes a row and
  // withdraws a confirmation, for no change at all.
  const applies = captureApplies(t);
  const submission = submissionWith({
    dataAvailabilityStatement: 'Not found',
    dasConfirmedAt: new Date('2026-08-20T09:00:00Z')
  });

  const result = await applyToSubmission({
    submission, target: 'data_availability_statement', value: 'Not found'
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'unchanged');
  assert.deepEqual(applies, []);
  assert.ok(submission.dasConfirmedAt, 'and the confirmation stands');
});

test('a long value is truncated in the log, not in the submission', async (t) => {
  // An author list is kilobytes of JSON and the log is read as a list. The
  // execution holds the full output; this only has to be recognisable.
  const applies = captureApplies(t);
  const many = { items: Array.from({ length: 400 }, (_, i) => ({ lastName: `Author${i}` })), meta: {} };
  const submission = submissionWith();

  await applyToSubmission({ submission, target: 'authors', value: many });

  assert.equal(submission.authors.items.length, 400);
  assert.ok(applies[0].newValue.length <= 2001);
  assert.ok(applies[0].newValue.endsWith('…'));
});

test('every target names a real submission field', () => {
  // A typo here writes a property Sequelize ignores: the apply reports success,
  // the log says the value was set, and the submission is unchanged.
  const attributes = Object.keys(models.Submission.getAttributes());
  const missing = Object.entries(TARGETS)
    .filter(([, spec]) => !attributes.includes(spec.field))
    .map(([name, spec]) => `${name} -> ${spec.field}`);

  assert.deepEqual(missing, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// The rule, as a property of the source
//
// "A step writes only to its own execution" is not something a behavioural test
// can pin: a service added tomorrow that assigns submission.authors directly
// would pass every test above while reintroducing exactly what this exists to
// stop. So the source is read, in the same spirit as one-restart-path.test.js.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const { servicesMatching } = require('../../test-helpers/service-files');

test('no service writes an applied field except the apply service', () => {
  const fields = Object.values(TARGETS).map((spec) => spec.field);
  const assignment = new RegExp(`submission\\.(${fields.join('|')})\\s*=`);

  const offenders = servicesMatching(assignment, {
    except: [path.join('queue', 'apply.service.js')]
  });

  assert.deepEqual(offenders, [],
    'these promote a value into the submission without recording that they did');
});
