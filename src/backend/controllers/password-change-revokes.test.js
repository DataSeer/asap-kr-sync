/**
 * Changing a password ends the other sessions.
 *
 * Without this, a stolen session survived the change for the rest of the 7-day
 * refresh window — which is the whole reason someone changes a password in a
 * hurry. The change did not do what the person believed it did.
 *
 * Two paths, and they differ on purpose: a user changing their OWN password
 * keeps the browser they are typing in (signing them out of it is a bug wearing
 * security's clothes, and it teaches people not to change their password); an
 * admin resetting someone else's ends every session, because the usual reason
 * for an admin reset is that the account may be compromised.
 */

'use strict';

// `jwt.service` throws at module load when JWT_SECRET is unset, and this file
// reaches it through auth.service. Set before the requires below, because a
// CommonJS require runs its module body immediately.
//
// It passed locally without this and failed in CI: `config/database.js` calls
// `dotenv.config()`, so requiring the models quietly loads the developer's
// .env into the process first. A CI runner has no .env, so nothing set the
// secret. A test that passes only because of an untracked file on one machine
// is not a passing test — so the value it needs is declared here.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-for-signing-anything-real';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { User, UserTeam, RefreshToken, sequelize } = require('../models');
const authService = require('../services/auth/auth.service');
const profileController = require('./profile.controller');
const usersController = require('./users.controller');

const USER_ID = 'user-1';
const ADMIN_ID = 'admin-1';

async function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      json: (body) => resolve({ body, error: null }),
      status(code) { this.statusCode = code; return this; }
    };
    handler({ params: {}, body: {}, cookies: {}, ...req }, res, (error) => resolve({ body: null, error }));
  });
}

function userRow(over = {}) {
  return {
    id: USER_ID,
    email: 'author@example.com',
    name: 'Author',
    role: 'author',
    passwordHash: '$2b$12$' + 'x'.repeat(53),
    auth0Sub: null,
    deleted: false,
    async verifyPassword() { return true; },
    async save() { return this; },
    toJSON() { return { id: this.id, email: this.email, name: this.name, role: this.role }; },
    ...over
  };
}

/** Capture the revocation call without touching a database. */
function mockAll(t, row) {
  const calls = [];
  t.mock.method(User, 'findByPk', async () => row);
  t.mock.method(User, 'findOne', async () => row);
  t.mock.method(UserTeam, 'findAll', async () => []);
  t.mock.method(UserTeam, 'destroy', async () => 0);
  t.mock.method(UserTeam, 'bulkCreate', async () => []);
  t.mock.method(sequelize, 'transaction', async (fn) => fn({ id: 'tx' }));
  t.mock.method(authService, 'revokeAllForUser', async (userId, reason, opts) => {
    calls.push({ userId, reason, opts });
    return 2;
  });
  return calls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Changing your own password
// ─────────────────────────────────────────────────────────────────────────────

test('a self-service password change signs the other devices out', async (t) => {
  const calls = mockAll(t, userRow());

  await call(profileController.updateProfile, {
    userId: USER_ID,
    validatedBody: { currentPassword: 'old-one', newPassword: 'a-new-password' },
    cookies: { asap_kr_refresh: 'this-browsers-token' }
  });

  assert.equal(calls.length, 1, 'the other sessions must not outlive the password');
  assert.equal(calls[0].userId, USER_ID);
  assert.equal(calls[0].reason, 'password_changed');
});

test('...but not out of the browser doing the changing', async (t) => {
  const calls = mockAll(t, userRow());

  await call(profileController.updateProfile, {
    userId: USER_ID,
    validatedBody: { currentPassword: 'old-one', newPassword: 'a-new-password' },
    cookies: { asap_kr_refresh: 'this-browsers-token' }
  });

  assert.equal(calls[0].opts.exceptRawToken, 'this-browsers-token',
    'signing the user out of the tab they are typing in teaches them not to do this');
});

test('changing only the name revokes nothing', async (t) => {
  const calls = mockAll(t, userRow());

  await call(profileController.updateProfile, { userId: USER_ID, validatedBody: { name: 'New Name' } });

  assert.equal(calls.length, 0, 'renaming yourself is not a security event');
});

test('a rejected password change revokes nothing', async (t) => {
  // The wrong current password must not become a way to sign someone else out.
  const calls = mockAll(t, userRow({ async verifyPassword() { return false; } }));

  const { error } = await call(profileController.updateProfile, {
    userId: USER_ID,
    validatedBody: { currentPassword: 'wrong', newPassword: 'a-new-password' }
  });

  assert.ok(error, 'expected the change to be refused');
  assert.equal(calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// An admin resetting someone else's
// ─────────────────────────────────────────────────────────────────────────────

test('an admin reset ends every session, with no exception', async (t) => {
  const calls = mockAll(t, userRow());

  await call(usersController.update, {
    params: { id: USER_ID },
    userId: ADMIN_ID,
    user: { id: ADMIN_ID, role: 'admin' },
    validatedBody: { password: 'reset-by-admin' }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'password_changed');
  assert.equal(calls[0].opts, undefined,
    'the admin holds none of these sessions, and a reset usually means the account may be compromised');
});

test('an admin changing a role or a name revokes nothing', async (t) => {
  const calls = mockAll(t, userRow());

  await call(usersController.update, {
    params: { id: USER_ID },
    userId: ADMIN_ID,
    user: { id: ADMIN_ID, role: 'admin' },
    validatedBody: { role: 'asap_pm' }
  });

  assert.equal(calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// The revocation itself
// ─────────────────────────────────────────────────────────────────────────────

test('revokeAllForUser spares exactly one token when asked', async (t) => {
  let captured = null;
  t.mock.method(RefreshToken, 'update', async (values, options) => {
    captured = { values, where: options.where };
    return [3];
  });

  await authService.revokeAllForUser(USER_ID, 'password_changed', { exceptRawToken: 'keep-me' });

  assert.equal(captured.where.userId, USER_ID);
  assert.equal(captured.where.revokedAt, null, 'only the still-live ones');
  assert.ok(captured.where.tokenHash, 'the spared token is excluded by hash, never by raw value');
  assert.equal(captured.values.revokedReason, 'password_changed');
});

test('revokeAllForUser spares nothing when not asked', async (t) => {
  let captured = null;
  t.mock.method(RefreshToken, 'update', async (values, options) => {
    captured = { values, where: options.where };
    return [3];
  });

  await authService.revokeAllForUser(USER_ID, 'password_changed');

  assert.equal(captured.where.tokenHash, undefined);
});
