/**
 * Who may start analysis work, and how much of it.
 *
 * Re-running a module is open to anyone who can reach the submission — the
 * server always accepted it, and the author is the person best placed to notice
 * a wrong result. What separates the roles is a daily BUDGET, not a hidden
 * button: a quota is honest about the real constraint (LM spend), and a user
 * can see where they stand. A hidden button just leaves them stuck.
 *
 * The numbers live in `conf/rate-limits.json`; these tests pin the RULES —
 * which roles are capped, which are not, and that "unlimited" is expressed by
 * skipping rather than by a large number.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dailyLimitFor } = require('./rate-limit.middleware');
const { RATE_LIMITS } = require('../config/constants');

const as = (role) => ({ user: { id: 'u1', role } });

test('an author gets a modest daily allowance', () => {
  assert.equal(dailyLimitFor(as('author')), 10);
});

test('a project manager gets a lab\'s worth', () => {
  assert.equal(dailyLimitFor(as('asap_pm')), 50);
  assert.ok(dailyLimitFor(as('asap_pm')) > dailyLimitFor(as('author')));
});

test('curators and admins are unlimited, expressed as 0', () => {
  // 0 means "no cap" here and the middleware SKIPS those requests. Handing them
  // a very large number instead would still record every request in the store,
  // for a limit that can never be reached.
  assert.equal(dailyLimitFor(as('ds_annotator')), 0);
  assert.equal(dailyLimitFor(as('admin')), 0);
});

test('an unknown or missing role is unlimited, not zero-allowance', () => {
  // Failing closed here would lock out a role added to the app before it is
  // added to the config — and it would look like a broken button, not a policy.
  assert.equal(dailyLimitFor({}), 0);
  assert.equal(dailyLimitFor(as('some_future_role')), 0);
});

test('the window is a day, not a minute', () => {
  // The per-minute limiter is a separate, burst-stopping budget. If this one
  // ever collapsed to the same window it would silently stop being a policy.
  assert.equal(RATE_LIMITS.lmApiDaily.windowMs, 24 * 60 * 60 * 1000);
  assert.ok(RATE_LIMITS.lmApiDaily.windowMs > RATE_LIMITS.lmApi.windowMs);
});

test('the message tells the user when it resets', () => {
  // "Too many requests" over a 24-hour window is unactionable.
  assert.match(RATE_LIMITS.lmApiDaily.message, /daily limit/i);
  assert.match(RATE_LIMITS.lmApiDaily.message, /reset/i);
});

test('every role the app defines has an entry', () => {
  const { ROLES } = require('../config/constants');
  for (const role of Object.values(ROLES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(RATE_LIMITS.lmApiDaily.max, role),
      `${role} has no daily budget — it would silently default to unlimited`
    );
  }
});
