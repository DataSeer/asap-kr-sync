/**
 * A refresh token replayed seconds after its rotation is a race, not a theft.
 *
 * Two tabs of one browser both get a 401 on an expired access token and both
 * POST /auth/refresh with the same cookie. The first rotates the token; the
 * second is now replaying a rotated-out token, which reuse detection used to
 * read as compromise — and it wiped every live token for the user, signing
 * them out of everything and losing the action they had just taken (ASAP,
 * 2026-09). Inside a short window that replay is merely rejected; beyond it,
 * the wipe stands.
 */
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-for-signing-anything-real';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RefreshToken } = require('../../models');
const jwtService = require('./jwt.service');
const authService = require('./auth.service');

function rotatedRecord(msAgo) {
  return {
    id: 'old', userId: 'user-1', tokenHash: 'h',
    revokedAt: new Date(Date.now() - msAgo), revokedReason: 'rotation', replacedBy: 'new',
    expiresAt: new Date(Date.now() + 86400000)
  };
}

function mockAll(t, record) {
  const wipes = [];
  t.mock.method(jwtService, 'verifyRefreshToken', () => ({ userId: 'user-1' }));
  t.mock.method(RefreshToken, 'findOne', async () => record);
  t.mock.method(RefreshToken, 'update', async (values, opts) => { wipes.push({ values, opts }); return [2]; });
  return wipes;
}

test('a replay seconds after rotation is rejected without wiping the chain', async (t) => {
  const wipes = mockAll(t, rotatedRecord(2000));
  await assert.rejects(() => authService.refreshTokens('raw'), /already rotated/);
  assert.equal(wipes.length, 0, 'the other tab still holds a valid session — do not sign the user out');
});

test('a replay long after rotation is still treated as compromise', async (t) => {
  const wipes = mockAll(t, rotatedRecord(5 * 60 * 1000));
  await assert.rejects(() => authService.refreshTokens('raw'), /compromised/);
  assert.equal(wipes.length, 1);
  assert.equal(wipes[0].values.revokedReason, 'reuse_detected');
});

test('the window does not soften a logout replay', async (t) => {
  const wipes = mockAll(t, { ...rotatedRecord(1000), revokedReason: 'logout' });
  await assert.rejects(() => authService.refreshTokens('raw'), /please log in again/);
  assert.equal(wipes.length, 0);
});

test('the access token lives a day by default', () => {
  // A developer's .env may override the lifetime (config/database.js loads it
  // through dotenv); the default is what matters here.
  const expected = process.env.JWT_EXPIRES_IN || '1d';
  assert.equal(jwtService.generateTokenPair({ id: 'u', email: 'e', role: 'author' }).expiresIn, expected);
});
