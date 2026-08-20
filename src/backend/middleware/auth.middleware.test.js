/**
 * Who the request is, and everything that must NOT establish an identity.
 *
 * This is the gate every other permission check sits behind, so the cases worth
 * pinning are the negative ones: a token signed with the wrong key, an expired
 * one, a refresh token presented as a session, and — the classic setup here —
 * an algorithm-confusion attempt, since a local HS256 verifier runs alongside
 * an Auth0 RS256 one. Each of those must leave the request anonymous rather
 * than authenticated.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { User } = require('../models');
const auth0Service = require('../services/auth/auth0.service');
const { authenticate, optionalAuth } = require('./auth.middleware');

const SECRET = 'test-secret-for-this-file-only';
const SESSION_COOKIE = 'asap_kr_session';
const USER_ID = 'user-1';

let originalSecret;
beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

/** A user row shaped the way the middleware reads it. */
const userRow = (over = {}) => ({
  toJSON: () => ({
    id: USER_ID, email: 'author@example.com', name: 'Author',
    role: 'author', auth0Sub: null,
    userTeams: [{ team: 'WH' }, { team: 'XC' }],
    ...over
  }),
  id: over.id || USER_ID
});

function mockUser(t, row = userRow()) {
  t.mock.method(User, 'findOne', async () => row);
}

const req = (token) => ({ cookies: token ? { [SESSION_COOKIE]: token } : {} });

/** Run the middleware and report what happened, without throwing. */
async function run(middleware, request) {
  return new Promise((resolve) => {
    middleware(request, {}, (err) => resolve({ err: err || null, req: request }));
  });
}

const sign = (payload, opts = {}) => jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '15m', ...opts });

// ─────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────

test('a valid session token identifies the user', async (t) => {
  mockUser(t);
  const { err, req: r } = await run(authenticate, req(sign({ userId: USER_ID, type: 'access' })));

  assert.equal(err, null);
  assert.equal(r.userId, USER_ID);
  assert.equal(r.user.role, 'author');
});

test('the user\'s teams are flattened onto the request', async (t) => {
  // Team scoping downstream reads `req.user.teams`; leaving the raw association
  // shape would make every team check silently fail.
  mockUser(t);
  const { req: r } = await run(authenticate, req(sign({ userId: USER_ID, type: 'access' })));

  assert.deepEqual(r.user.teams, ['WH', 'XC']);
  assert.equal(r.user.userTeams, undefined, 'the raw association must not leak through');
});

test('a user with no teams gets an empty list, not undefined', async (t) => {
  mockUser(t, userRow({ userTeams: null }));
  const { req: r } = await run(authenticate, req(sign({ userId: USER_ID, type: 'access' })));

  assert.deepEqual(r.user.teams, []);
});

test('a token issued before the type claim existed is still accepted', async (t) => {
  // Documented tolerance: those age out within one expiry window.
  mockUser(t);
  const { err, req: r } = await run(authenticate, req(sign({ userId: USER_ID })));

  assert.equal(err, null);
  assert.equal(r.userId, USER_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// Everything that must NOT authenticate
// ─────────────────────────────────────────────────────────────────────────────

test('no cookie means no identity', async (t) => {
  mockUser(t);
  const { err, req: r } = await run(authenticate, req(null));

  assert.ok(err, 'a request with no token must be rejected');
  assert.equal(r.user, undefined);
});

test('a token signed with a different secret is refused', async (t) => {
  mockUser(t);
  const foreign = jwt.sign({ userId: USER_ID, type: 'access' }, 'not-the-secret', { algorithm: 'HS256' });
  const { err, req: r } = await run(authenticate, req(foreign));

  assert.ok(err);
  assert.equal(r.userId, undefined);
});

test('an expired token is refused', async (t) => {
  mockUser(t);
  const expired = jwt.sign({ userId: USER_ID, type: 'access' }, SECRET, { algorithm: 'HS256', expiresIn: '-1s' });
  const { err } = await run(authenticate, req(expired));

  assert.ok(err);
});

test('an "alg: none" token is refused', async (t) => {
  // The algorithm is pinned precisely so an unsigned token cannot pass.
  mockUser(t);
  const unsigned = jwt.sign({ userId: USER_ID, type: 'access' }, '', { algorithm: 'none' });
  const { err, req: r } = await run(authenticate, req(unsigned));

  assert.ok(err, 'an unsigned token must never authenticate');
  assert.equal(r.userId, undefined);
});

test('a token signed with a DIFFERENT algorithm is refused', async (t) => {
  // What pinning HS256 actually buys. `jsonwebtoken` rejects `alg: none` on its
  // own, but without the pin it happily accepts any HMAC variant made with the
  // same secret — and this verifier runs alongside an RS256 one, which is the
  // classic algorithm-confusion setup.
  mockUser(t);
  t.mock.method(auth0Service, 'isEnabled', () => false);

  for (const algorithm of ['HS384', 'HS512']) {
    const token = jwt.sign({ userId: USER_ID, type: 'access' }, SECRET, { algorithm });
    const { err, req: r } = await run(authenticate, req(token));
    assert.ok(err, `${algorithm} must not authenticate`);
    assert.equal(r.userId, undefined);
  }
});

test('a refresh token presented as a session is refused', async (t) => {
  // Same secret and algorithm — only the `type` claim separates them, so this
  // check is the entire defence against a longer-lived token being used as one.
  mockUser(t);
  const { err, req: r } = await run(authenticate, req(sign({ userId: USER_ID, type: 'refresh' })));

  assert.ok(err);
  assert.equal(r.userId, undefined);
});

test('any unexpected token class is refused, not just refresh', async (t) => {
  mockUser(t);
  for (const type of ['reset', 'invite', 'id', '']) {
    const { err } = await run(authenticate, req(sign({ userId: USER_ID, type })));
    assert.ok(err, `type "${type}" must not authenticate`);
  }
});

test('a well-formed token for a user who no longer exists is refused', async (t) => {
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(auth0Service, 'isEnabled', () => false);

  const { err, req: r } = await run(authenticate, req(sign({ userId: 'deleted-user', type: 'access' })));

  assert.ok(err, 'a deleted user must not keep a working session');
  assert.equal(r.userId, undefined);
});

test('a garbage cookie value is refused rather than crashing', async (t) => {
  mockUser(t);
  t.mock.method(auth0Service, 'isEnabled', () => false);
  for (const value of ['not-a-jwt', 'a.b.c', '...', '{}']) {
    const { err } = await run(authenticate, req(value));
    assert.ok(err, `"${value}" must not authenticate`);
  }
});

test('the Authorization header does not authenticate anything', async (t) => {
  // Cookie-only by design; accepting Bearer would reopen the CSRF story the
  // cookie + double-submit token closes.
  mockUser(t);
  const request = { cookies: {}, headers: { authorization: `Bearer ${sign({ userId: USER_ID, type: 'access' })}` } };
  const { err, req: r } = await run(authenticate, request);

  assert.ok(err);
  assert.equal(r.userId, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// optionalAuth — same verification, different failure
// ─────────────────────────────────────────────────────────────────────────────

test('optionalAuth identifies a valid user', async (t) => {
  mockUser(t);
  const { err, req: r } = await run(optionalAuth, req(sign({ userId: USER_ID, type: 'access' })));

  assert.equal(err, null);
  assert.equal(r.userId, USER_ID);
});

test('optionalAuth continues anonymously when there is no token', async (t) => {
  mockUser(t);
  const { err, req: r } = await run(optionalAuth, req(null));

  assert.equal(err, null, 'this route is open — no token is not an error');
  assert.equal(r.user, undefined);
});

test('optionalAuth continues anonymously on a BAD token, rather than trusting it', async (t) => {
  // The important half: an invalid token must not become an identity just
  // because the route tolerates anonymity.
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(auth0Service, 'isEnabled', () => false);

  const foreign = jwt.sign({ userId: USER_ID, type: 'access' }, 'not-the-secret', { algorithm: 'HS256' });
  const { err, req: r } = await run(optionalAuth, req(foreign));

  assert.equal(err, null);
  assert.equal(r.userId, undefined, 'a forged token must leave the request anonymous');
});

// ─────────────────────────────────────────────────────────────────────────────
// Anonymised accounts
// ─────────────────────────────────────────────────────────────────────────────

test('a deleted account cannot be resolved from a still-valid token', async (t) => {
  // Deleting a user anonymises the row rather than removing it, so the row is
  // still findable by id. Every authenticated request resolves its user
  // through this one query, which makes it the place the exclusion has to
  // live — a filter applied only in the users list would not stop a session
  // that was open when the account was closed.
  const seen = [];
  t.mock.method(User, 'findOne', async (options) => { seen.push(options.where); return null; });
  t.mock.method(auth0Service, 'isEnabled', () => false);

  const { err } = await run(authenticate, req(sign({ userId: USER_ID, type: 'access' })));

  assert.ok(err, 'an anonymised account must not authenticate');
  assert.equal(seen[0].deleted, false, 'the lookup must exclude deleted accounts');
});

test('the Auth0 lookup excludes deleted accounts too', async (t) => {
  const seen = [];
  t.mock.method(auth0Service, 'isEnabled', () => true);
  t.mock.method(auth0Service, 'verifyAccessToken', async () => ({ sub: 'auth0|abc' }));
  t.mock.method(User, 'findOne', async (options) => { seen.push(options.where); return null; });

  await run(authenticate, req('an-auth0-token'));

  assert.ok(seen.length, 'the Auth0 path must reach the user lookup');
  assert.ok(seen.every(w => w.deleted === false), 'every branch goes through the same guard');
});

// ─────────────────────────────────────────────────────────────────────────────
// The Auth0 fallback
// ─────────────────────────────────────────────────────────────────────────────

test('an Auth0 token identifies the linked local user', async (t) => {
  t.mock.method(auth0Service, 'isEnabled', () => true);
  t.mock.method(auth0Service, 'verifyAccessToken', async () => ({ sub: 'auth0|abc' }));
  t.mock.method(User, 'findOne', async () => userRow({ auth0Sub: 'auth0|abc' }));

  const { err, req: r } = await run(authenticate, req('an-auth0-token'));

  assert.equal(err, null);
  assert.equal(r.userId, USER_ID);
});

test('an Auth0 token with no linked local user is refused', async (t) => {
  t.mock.method(auth0Service, 'isEnabled', () => true);
  t.mock.method(auth0Service, 'verifyAccessToken', async () => ({ sub: 'auth0|nobody' }));
  t.mock.method(User, 'findOne', async () => null);

  const { err } = await run(authenticate, req('an-auth0-token'));

  assert.ok(err, 'a valid external token is not by itself an account here');
});

test('the Auth0 path is not tried when Auth0 is not configured', async (t) => {
  t.mock.method(auth0Service, 'isEnabled', () => false);
  const verify = t.mock.method(auth0Service, 'verifyAccessToken', async () => ({ sub: 'auth0|abc' }));
  t.mock.method(User, 'findOne', async () => null);

  await run(authenticate, req('some-token'));

  assert.equal(verify.mock.callCount(), 0);
});

test('an Auth0 token is refused when Auth0 is switched OFF', async (t) => {
  // The flag has to actually turn it off. The fallback was gated on
  // `isConfigured` — credentials present — so an operator who set
  // AUTH0_ENABLED=false while leaving the credentials in place still accepted
  // any live Auth0 token whose `sub` matched a linked local user.
  t.mock.method(auth0Service, 'isEnabled', () => false);
  const verify = t.mock.method(auth0Service, 'verifyAccessToken', async () => ({ sub: 'auth0|abc' }));
  t.mock.method(User, 'findOne', async () => userRow({ auth0Sub: 'auth0|abc' }));

  const { err, req: r } = await run(authenticate, req('an-auth0-token'));

  assert.ok(err, 'the switch must be honoured');
  assert.equal(r.userId, undefined);
  assert.equal(verify.mock.callCount(), 0, 'it must not even be verified');
});

test('credentials present but the flag off is still off', async (t) => {
  // The precise combination that was broken: configured, not enabled.
  t.mock.method(auth0Service, 'isConfigured', () => true);
  t.mock.method(auth0Service, 'isEnabled', () => false);
  t.mock.method(auth0Service, 'verifyAccessToken', async () => ({ sub: 'auth0|abc' }));
  t.mock.method(User, 'findOne', async () => userRow({ auth0Sub: 'auth0|abc' }));

  const { err } = await run(authenticate, req('an-auth0-token'));

  assert.ok(err);
});
