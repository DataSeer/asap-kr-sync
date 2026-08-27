/**
 * Setting another user's password is admin-only.
 *
 * `PATCH /api/users/:id` is reachable by `admin` AND `ds_annotator`, and its
 * body accepts `password` with no current-password challenge. So an annotator
 * could set the password of any author, PM or fellow annotator — and, knowing
 * it, sign in as them. That is account takeover, not a lesser form of editing:
 * every other field on this endpoint is recoverable, this one hands over the
 * account and everything the account can reach.
 *
 * `assertCanTouchAdminRole` already stopped an annotator reaching an ADMIN
 * account, so the exposure was every non-admin user. These tests pin the
 * boundary from both sides: an annotator must still be able to do the ordinary
 * edits the role exists for, and must not be able to send a password.
 */

'use strict';

// jwt.service throws at module load when JWT_SECRET is unset, and this file
// reaches it through the controller's auth.service import. A CommonJS require
// runs its body immediately, so this has to be set before the requires below.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-for-signing-anything-real';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { User, UserTeam, sequelize } = require('../models');
const authService = require('../services/auth/auth.service');
const controller = require('./users.controller');

const ADMIN = { id: 'admin-1', role: 'admin' };
const ANNOTATOR = { id: 'ds-1', role: 'ds_annotator' };
const PM = { id: 'pm-1', role: 'asap_pm' };
const TARGET_ID = 'target-1';

/** Run the handler and capture whichever of res/next it reached. */
async function call(req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      json: (body) => resolve({ body, error: null }),
      status(code) { this.statusCode = code; return this; }
    };
    controller.update({ params: {}, body: {}, ...req }, res, (error) => resolve({ body: null, error }));
  });
}

/** A target row that records assignments the way Sequelize would. */
function userRow(over = {}) {
  return {
    id: TARGET_ID,
    email: 'author@example.com',
    name: 'An Author',
    role: 'author',
    passwordHash: '$2b$12$' + 'original'.repeat(6),
    deleted: false,
    saved: false,
    async save() { this.saved = true; },
    toJSON() { return { id: this.id, name: this.name, role: this.role }; },
    ...over
  };
}

function mockModels(t, row) {
  const captured = { revokedFor: null };
  t.mock.method(User, 'findOne', async () => row);
  t.mock.method(UserTeam, 'destroy', async () => 0);
  t.mock.method(UserTeam, 'bulkCreate', async () => []);
  // update() re-reads the team list to build its response; unstubbed this is
  // the one call that reaches a real database.
  t.mock.method(UserTeam, 'findAll', async () => []);
  t.mock.method(sequelize, 'transaction', async (fn) => fn({ id: 'tx' }));
  t.mock.method(authService, 'revokeAllForUser', async (userId) => {
    captured.revokedFor = userId;
    return 2;
  });
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// The boundary
// ─────────────────────────────────────────────────────────────────────────────

test('an admin can set another user\'s password', async (t) => {
  const row = userRow();
  const captured = mockModels(t, row);

  const { error } = await call({
    params: { id: TARGET_ID },
    user: ADMIN,
    userId: ADMIN.id,
    validatedBody: { password: 'a-brand-new-password' }
  });

  assert.equal(error, null);
  assert.equal(row.passwordHash, 'a-brand-new-password', 'the admin path must still work');
  assert.equal(captured.revokedFor, TARGET_ID, 'a reset still ends the target\'s sessions');
});

test('an annotator cannot set another user\'s password', async (t) => {
  const row = userRow();
  const original = row.passwordHash;
  mockModels(t, row);

  const { error } = await call({
    params: { id: TARGET_ID },
    user: ANNOTATOR,
    userId: ANNOTATOR.id,
    validatedBody: { password: 'taking-this-account' }
  });

  assert.ok(error, 'the request must be refused');
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'AUTHORIZATION_ERROR');
  assert.equal(row.passwordHash, original, 'the hash must be untouched');
  assert.equal(row.saved, false, 'nothing may be persisted on a refused request');
});

test('a PM cannot set another user\'s password either', async (t) => {
  // The route guard already excludes a PM. This asserts the controller does not
  // depend on that guard staying where it is — the check is on the actor's role,
  // not on which route happened to reach it.
  const row = userRow();
  mockModels(t, row);

  const { error } = await call({
    params: { id: TARGET_ID },
    user: PM,
    userId: PM.id,
    validatedBody: { password: 'taking-this-account' }
  });

  assert.ok(error);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'AUTHORIZATION_ERROR');
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusal is about the password, not about the annotator
// ─────────────────────────────────────────────────────────────────────────────

test('an annotator can still rename a user and change a non-admin role', async (t) => {
  const row = userRow();
  mockModels(t, row);

  const { error } = await call({
    params: { id: TARGET_ID },
    user: ANNOTATOR,
    userId: ANNOTATOR.id,
    validatedBody: { name: 'Renamed Author', role: 'asap_pm' }
  });

  assert.equal(error, null, 'user administration is what the annotator role is for');
  assert.equal(row.name, 'Renamed Author');
  assert.equal(row.role, 'asap_pm');
  assert.equal(row.saved, true);
});

test('an annotator sending an empty password is not refused', async (t) => {
  // The Edit User form posts the whole object; an untouched password field is
  // ''. Refusing that would break every ordinary edit, so the check is on a
  // password actually being supplied.
  const row = userRow();
  mockModels(t, row);

  const { error } = await call({
    params: { id: TARGET_ID },
    user: ANNOTATOR,
    userId: ANNOTATOR.id,
    validatedBody: { name: 'Renamed Author', password: '' }
  });

  assert.equal(error, null);
  assert.equal(row.name, 'Renamed Author');
});

test('the password check runs before anything is written', async (t) => {
  // A refusal that still renamed the user would be a partial write on a request
  // the server rejected.
  const row = userRow();
  mockModels(t, row);

  await call({
    params: { id: TARGET_ID },
    user: ANNOTATOR,
    userId: ANNOTATOR.id,
    validatedBody: { name: 'Renamed Author', password: 'taking-this-account' }
  });

  assert.equal(row.name, 'An Author', 'the rename must not land when the request is refused');
  assert.equal(row.saved, false);
});
