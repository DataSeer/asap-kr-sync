/**
 * Merging KRT rows: what happens around the commit.
 *
 * The merge itself is a transaction — create the merged row, log it, delete the
 * originals — and the bug was not in any of that. It was in the work AFTER the
 * commit: re-validating the new row is explicitly non-critical, but it writes
 * rows of its own and can throw, and the catch then called `rollback()` on a
 * transaction that had already committed. Sequelize rejects that, the rejection
 * escaped before `next(error)` ran, and Express 4 does not forward an async
 * rejection — so a merge that had SUCCEEDED left the client waiting forever,
 * with the rows already merged in the database.
 *
 * That is only visible in the ORDER of commit / rollback / response, which is
 * what `fakeTransaction` records.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { KRTData, ChangeLog, ValidationResult } = require('../models');
const validatorService = require('../services/krt/validator.service');
const controller = require('./krt.controller');
const { fakeTransaction, callController } = require('../test-helpers/fake-transaction');

const SUBMISSION_ID = 'sub-1';

const row = (id, over = {}) => ({
  id,
  submissionId: SUBMISSION_ID,
  round: 1,
  resourceName: `Row ${id}`,
  toKRTRow() { return { id: this.id, 'RESOURCE NAME': this.resourceName }; },
  ...over
});

function mockModels(t, { originals = [row('a'), row('b')], validate } = {}) {
  const created = [];
  const destroyed = [];
  t.mock.method(KRTData, 'findAll', async () => originals);
  t.mock.method(KRTData, 'create', async (attrs) => {
    const made = row('merged-1', attrs);
    created.push(attrs);
    return made;
  });
  t.mock.method(KRTData, 'destroy', async (options) => { destroyed.push(options.where); return 2; });
  t.mock.method(ChangeLog, 'create', async (attrs) => { created.push(attrs); return attrs; });
  t.mock.method(ValidationResult, 'destroy', async () => 0);
  t.mock.method(validatorService, 'validateRow', validate || (async () => ({ errors: [] })));
  return { created, destroyed };
}

const request = (over = {}) => ({
  params: { id: SUBMISSION_ID },
  submission: { currentRound: 1, status: 'step_krt' },
  user: { role: 'author' },
  userId: 'user-1',
  body: { rowIds: ['a', 'b'], merged: { resourceName: 'Merged row' } },
  ...over
});

// ─────────────────────────────────────────────────────────────────────────────
// The happy path, and the one that used to hang
// ─────────────────────────────────────────────────────────────────────────────

test('a successful merge commits once and never rolls back', async (t) => {
  const tx = fakeTransaction(t);
  mockModels(t);

  const { body, error, statusCode } = await callController(controller.mergeRows, request());

  assert.equal(error, null);
  assert.equal(statusCode, 201);
  assert.ok(body.row);
  assert.deepEqual(tx.calls, ['commit']);
});

test('a re-validation failure after the commit does NOT roll back', async (t) => {
  // The exact bug. Re-validation is non-critical and writes its own rows; when
  // it threw, the catch rolled back a committed transaction, Sequelize
  // rejected, and the response never came.
  const tx = fakeTransaction(t);
  mockModels(t, { validate: async () => { throw new Error('validator exploded'); } });

  const { body, error } = await callController(controller.mergeRows, request());

  assert.equal(error, null, 'a merge that succeeded must not report failure');
  assert.ok(body.row, 'and it must still answer');
  assert.deepEqual(tx.calls, ['commit'], 'rollback after commit is what hung the client');
});

test('the `committed` guard survives, even though the inner catch hides it', async (t) => {
  // Belt and braces, and deliberately so. The inner catch is what stops
  // re-validation reaching the outer one; the `committed` flag is what stops
  // the outer one rolling back a finished transaction. Either alone is enough
  // today, which means a mutation of one is invisible — so this asserts the
  // second directly, by driving the outer catch with a failure raised AFTER the
  // commit through a different route.
  const tx = fakeTransaction(t);
  mockModels(t);
  const boom = new Error('response serialisation failed');
  t.mock.method(KRTData, 'create', async (attrs) => ({
    ...row('merged-1', attrs),
    toKRTRow() { throw boom; }
  }));

  const { error } = await callController(controller.mergeRows, request());

  assert.equal(error, boom, 'the failure is reported...');
  assert.deepEqual(tx.calls, ['commit'], '...without rolling back work that is already committed');
});

test('the response arrives even when re-validation throws — no silent hang', async (t) => {
  // callController rejects if the handler neither responds nor calls next().
  // That is the failure this file exists for, so it is asserted directly.
  fakeTransaction(t);
  mockModels(t, { validate: async () => { throw new Error('validator exploded'); } });

  await assert.doesNotReject(callController(controller.mergeRows, request()));
});

// ─────────────────────────────────────────────────────────────────────────────
// Failures before the commit
// ─────────────────────────────────────────────────────────────────────────────

test('a failure mid-transaction rolls back and never commits', async (t) => {
  const tx = fakeTransaction(t);
  mockModels(t);
  t.mock.method(KRTData, 'create', async () => { throw new Error('insert failed'); });

  const { error } = await callController(controller.mergeRows, request());

  assert.ok(error);
  assert.deepEqual(tx.calls, ['rollback']);
  assert.equal(tx.committed, false);
});

test('fewer than two rows is refused before anything is written', async (t) => {
  const tx = fakeTransaction(t);
  const { created } = mockModels(t);

  const { error } = await callController(controller.mergeRows,
    request({ body: { rowIds: ['a'], merged: {} } }));

  assert.ok(error);
  assert.deepEqual(tx.calls, ['rollback']);
  assert.equal(created.length, 0, 'nothing may be written on the refused path');
});

test('rows that do not belong to this submission are refused', async (t) => {
  // findAll is already scoped by submissionId and round; if it returns fewer
  // than two, the caller asked for rows that are not theirs.
  const tx = fakeTransaction(t);
  mockModels(t, { originals: [row('a')] });

  const { error } = await callController(controller.mergeRows, request());

  assert.ok(error);
  assert.deepEqual(tx.calls, ['rollback']);
});

// ─────────────────────────────────────────────────────────────────────────────
// What the merge writes
// ─────────────────────────────────────────────────────────────────────────────

test('the originals are deleted scoped to this submission and round', async (t) => {
  fakeTransaction(t);
  const { destroyed } = mockModels(t);

  await callController(controller.mergeRows, request());

  assert.equal(destroyed.length, 1);
  assert.deepEqual(destroyed[0].id, ['a', 'b']);
  assert.equal(destroyed[0].submissionId, SUBMISSION_ID, 'an unscoped delete would reach other submissions');
  assert.equal(destroyed[0].round, 1);
});

test('an author cannot set QC or Optional through a merge', async (t) => {
  // Same rule as updateRow. A merge body is a second door onto the same fields.
  fakeTransaction(t);
  const { created } = mockModels(t);

  await callController(controller.mergeRows, request({
    body: { rowIds: ['a', 'b'], merged: { resourceName: 'x', isQc: true, isOptional: true } }
  }));

  const newRow = created.find((c) => 'isQc' in c);
  assert.equal(newRow.isQc, false);
  assert.equal(newRow.isOptional, false);
});

test('a curator can', async (t) => {
  fakeTransaction(t);
  const { created } = mockModels(t);

  await callController(controller.mergeRows, request({
    user: { role: 'ds_annotator' },
    body: { rowIds: ['a', 'b'], merged: { resourceName: 'x', isQc: true, isOptional: true } }
  }));

  const newRow = created.find((c) => 'isQc' in c);
  assert.equal(newRow.isQc, true);
  assert.equal(newRow.isOptional, true);
});

test('the history records both the merge and each row it replaced', async (t) => {
  // Deleting rows without saying why leaves a hole in a record meant to be
  // complete — one entry per original, plus one for the row that replaced them.
  fakeTransaction(t);
  const { created } = mockModels(t);

  await callController(controller.mergeRows, request());

  const logs = created.filter((c) => c.action);
  assert.equal(logs.filter((l) => l.action === 'add_row').length, 1);
  assert.equal(logs.filter((l) => l.action === 'delete_row').length, 2, 'one per original');
});
