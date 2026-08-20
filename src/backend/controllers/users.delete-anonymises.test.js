/**
 * Deleting a user anonymises the account; it never removes the row.
 *
 * The row has to survive because two foreign keys are ON DELETE CASCADE:
 * `submissions.user_id` (a real DELETE took every manuscript the person had
 * submitted) and `change_logs.user_id` (it also erased their edits to OTHER
 * people's submissions, silently putting holes in a history that is supposed to
 * be complete). Neither loss was reported to the admin who clicked Delete.
 *
 * So these tests are about two things that must both hold: the identity is
 * genuinely destroyed — no password, no Auth0 link, no recoverable email, no
 * live session, no team — and the id is still there afterwards for the
 * dependent rows to point at.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { User, UserTeam, RefreshToken, sequelize } = require('../models');
const controller = require('./users.controller');

const ADMIN_ID = 'admin-1';
const TARGET_ID = 'target-1';

/** Run the handler and capture whichever of res/next it reached. */
async function call(req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      json: (body) => resolve({ body, error: null, statusCode: res.statusCode }),
      status(code) { this.statusCode = code; return this; }
    };
    controller.delete({ params: {}, body: {}, ...req }, res, (error) => resolve({ body: null, error }));
  });
}

/**
 * A user row that records what was written to it, the way Sequelize would:
 * assignments land on the instance and `save` persists whatever is there.
 */
function userRow(over = {}) {
  return {
    id: TARGET_ID,
    email: 'departing@example.com',
    name: 'Departing Curator',
    passwordHash: '$2b$12$' + 'x'.repeat(53),
    auth0Sub: 'auth0|departing',
    deleted: false,
    deletedAt: null,
    saved: false,
    async save() { this.saved = true; },
    ...over
  };
}

function mockModels(t, row) {
  const captured = { teamsDestroyed: null, tokensRevoked: null };
  t.mock.method(User, 'findByPk', async () => row);
  t.mock.method(UserTeam, 'destroy', async (options) => {
    captured.teamsDestroyed = options.where;
    return 2;
  });
  t.mock.method(RefreshToken, 'update', async (values, options) => {
    captured.tokensRevoked = { values, where: options.where };
    return [3];
  });
  t.mock.method(sequelize, 'transaction', async (fn) => fn({ id: 'tx' }));
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// The identity is destroyed
// ─────────────────────────────────────────────────────────────────────────────

test('the row survives the delete — it is flagged, not removed', async (t) => {
  const row = userRow();
  row.destroy = async () => { throw new Error('destroy() would cascade to submissions and change_logs'); };
  mockModels(t, row);

  const { error, body } = await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.equal(error, null);
  assert.ok(body.message);
  assert.equal(row.saved, true, 'the anonymised row must be persisted');
  assert.equal(row.deleted, true);
  assert.ok(row.deletedAt instanceof Date, 'the deletion has to be dated');
  assert.equal(row.id, TARGET_ID, 'the id is what the dependent rows point at');
});

test('the credentials are erased, which is what actually ends the sessions', async (t) => {
  const row = userRow();
  mockModels(t, row);

  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.equal(row.passwordHash, null, 'a kept hash is a password that still works');
  assert.equal(row.auth0Sub, null, 'a kept Auth0 link signs the account straight back in');
});

test('the email is replaced by something unguessable and non-routable', async (t) => {
  const row = userRow();
  mockModels(t, row);

  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.notEqual(row.email, 'departing@example.com');
  assert.ok(!row.email.includes('departing'), 'no fragment of the address may survive');
  assert.match(row.email, /^deleted-[0-9a-f]{32}@deleted\.invalid$/);
});

test('two anonymised accounts do not collide on the unique email column', async (t) => {
  const a = userRow();
  const b = userRow({ id: 'target-2', email: 'other@example.com' });
  mockModels(t, a);
  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });
  t.mock.restoreAll();
  mockModels(t, b);
  await call({ params: { id: 'target-2' }, userId: ADMIN_ID });

  assert.notEqual(a.email, b.email);
});

test('the address is random, not derived from the original', async (t) => {
  // sha256(email) would be stable, and anyone holding the address could then
  // confirm the account had existed. Same input twice must give two answers.
  const first = userRow();
  const second = userRow();
  mockModels(t, first);
  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });
  t.mock.restoreAll();
  mockModels(t, second);
  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.notEqual(first.email, second.email);
});

test('the name becomes a tombstone rather than being blanked', async (t) => {
  const row = userRow();
  mockModels(t, row);

  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.equal(row.name, 'Deleted user', 'history has to read as something');
});

// ─────────────────────────────────────────────────────────────────────────────
// Everything the account conferred goes with it
// ─────────────────────────────────────────────────────────────────────────────

test('team memberships are removed, so the account confers no more visibility', async (t) => {
  const captured = mockModels(t, userRow());

  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.deepEqual(captured.teamsDestroyed, { userId: TARGET_ID });
});

test('live refresh tokens are revoked, not left to run out the 7-day window', async (t) => {
  const captured = mockModels(t, userRow());

  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.ok(captured.tokensRevoked, 'an open session must not outlive the account');
  assert.equal(captured.tokensRevoked.where.userId, TARGET_ID);
  assert.equal(captured.tokensRevoked.where.revokedAt, null, 'only the still-live ones');
  assert.ok(captured.tokensRevoked.values.revokedAt instanceof Date);
  assert.equal(captured.tokensRevoked.values.revokedReason, 'account_deleted');
});

test('all of it happens in one transaction', async (t) => {
  const row = userRow();
  const captured = mockModels(t, row);
  const saves = [];
  row.save = async (options) => { saves.push(options); };

  await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  // A half-applied delete is the worst outcome: an anonymised row that still
  // carries its teams, or a scrubbed identity whose sessions are still live.
  assert.ok(saves[0] && saves[0].transaction, 'the save must join the transaction');
  assert.ok(captured.teamsDestroyed && captured.tokensRevoked);
});

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

test('an admin still cannot delete themselves', async (t) => {
  const row = userRow({ id: ADMIN_ID });
  mockModels(t, row);

  const { body, statusCode } = await call({ params: { id: ADMIN_ID }, userId: ADMIN_ID });

  assert.equal(statusCode, 400);
  assert.equal(row.saved, false, 'nothing may be written on the refused path');
  assert.ok(body.error);
});

test('deleting an already-deleted account is a conflict, not a second scrub', async (t) => {
  // Re-running it would mint a second random address and re-date the deletion,
  // rewriting when the account was closed.
  const row = userRow({ deleted: true, email: 'deleted-' + 'a'.repeat(32) + '@deleted.invalid' });
  mockModels(t, row);

  const { error } = await call({ params: { id: TARGET_ID }, userId: ADMIN_ID });

  assert.ok(error, 'expected a conflict');
  assert.equal(error.statusCode, 409);
  assert.equal(row.saved, false);
});

test('an unknown id is a 404', async (t) => {
  mockModels(t, null);

  const { error } = await call({ params: { id: 'nobody' }, userId: ADMIN_ID });

  assert.ok(error);
  assert.equal(error.statusCode, 404);
});
