/**
 * The team-email roster, and who is allowed to see or change which part of it.
 *
 * The roster maps an email address to a lab. It is other people's names and
 * addresses, and — because deleting an entry also revokes the matching
 * account's membership — it is an access-control surface, not just a list.
 *
 * These endpoints trusted the `team` in the request. A PM could list, add to,
 * and delete from ANY lab's roster, including cutting off another lab's
 * members. The scope is now derived from the caller (`user.teams` for a PM,
 * unrestricted for staff), so these tests are all about the boundary: what a PM
 * may reach, what they may not, and that staff keep the full roster.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Op } = require('sequelize');
const { Team, TeamEmail, User, UserTeam } = require('../models');
const teamEmailService = require('../services/teams/team-email.service');
const controller = require('./teams.controller');

const PM = { id: 'pm-1', role: 'asap_pm', teams: ['WH'] };
const ADMIN = { id: 'admin-1', role: 'admin', teams: [] };
const DS = { id: 'ds-1', role: 'ds_annotator', teams: [] };

/** Run a controller and capture whichever of res/next it reached. */
async function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      json: (body) => resolve({ body, error: null }),
      status(code) { this.statusCode = code; return this; }
    };
    handler({ query: {}, params: {}, body: {}, ...req }, res, (error) => resolve({ body: null, error }));
  });
}

/** Model stubs shared by the list/create/delete cases. */
function mockModels(t, { rows = [], mapping = null } = {}) {
  const captured = {};
  t.mock.method(TeamEmail, 'findAndCountAll', async (options) => {
    captured.where = options.where;
    return { rows, count: rows.length };
  });
  t.mock.method(TeamEmail, 'findByPk', async () => mapping);
  t.mock.method(TeamEmail, 'findOrCreate', async ({ where }) => {
    captured.created = [...(captured.created || []), where];
    return [where, true];
  });
  t.mock.method(Team, 'findAll', async () => [{ code: 'WH' }, { code: 'XC' }, { code: 'ML' }]);
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(UserTeam, 'destroy', async () => 1);
  t.mock.method(teamEmailService, 'applyMappingToExistingUser', async () => false);
  return captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────────────────────────────────────

test('a PM only ever queries their own teams\' entries', async (t) => {
  const captured = mockModels(t);

  await call(controller.listEmailMappings, { user: PM });

  assert.ok(captured.where.team, 'the query must be constrained at all');
  assert.deepEqual(captured.where.team[Op.in], ['WH']);
});

test('staff query the whole roster', async (t) => {
  for (const user of [ADMIN, DS]) {
    const captured = mockModels(t);
    await call(controller.listEmailMappings, { user });
    assert.equal(captured.where.team, undefined, `${user.role} must not be scoped`);
    t.mock.restoreAll();
  }
});

test('a PM asking for another team is refused, not quietly given their own', async (t) => {
  // Silently rewriting the filter would be worse: the caller believes they are
  // looking at XC.
  mockModels(t);

  const { error } = await call(controller.listEmailMappings, { user: PM, query: { team: 'XC' } });

  assert.ok(error, 'asking for a team outside the scope must fail');
  assert.match(error.message, /your own team/i);
});

test('a PM asking for their own team is allowed', async (t) => {
  const captured = mockModels(t);

  const { error } = await call(controller.listEmailMappings, { user: PM, query: { team: 'WH' } });

  assert.equal(error, null);
  assert.equal(captured.where.team, 'WH');
});

test('a PM with no teams can reach nothing', async (t) => {
  const captured = mockModels(t);

  await call(controller.listEmailMappings, { user: { ...PM, teams: [] } });

  assert.deepEqual(captured.where.team[Op.in], [],
    'an empty scope must match nothing, not everything');
});

test('a PM with several teams sees all of them', async (t) => {
  const captured = mockModels(t);

  await call(controller.listEmailMappings, { user: { ...PM, teams: ['WH', 'ML'] } });

  assert.deepEqual(captured.where.team[Op.in], ['WH', 'ML']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Adding
// ─────────────────────────────────────────────────────────────────────────────

test('a PM cannot add someone to another lab\'s roster', async (t) => {
  mockModels(t);

  const { error } = await call(controller.createEmailMappings, {
    user: PM,
    validatedBody: { mappings: [{ team: 'XC', email: 'someone@example.com' }] }
  });

  assert.ok(error);
  assert.match(error.message, /your own team/i);
});

test('one out-of-scope entry rejects the WHOLE batch', async (t) => {
  // A partial import would leave the caller unsure what landed.
  const captured = mockModels(t);

  const { error } = await call(controller.createEmailMappings, {
    user: PM,
    validatedBody: { mappings: [
      { team: 'WH', email: 'ok@example.com' },
      { team: 'XC', email: 'not-ok@example.com' }
    ] }
  });

  assert.ok(error);
  assert.equal(captured.created, undefined, 'nothing may be written when the batch is refused');
});

test('a PM can add to their own lab', async (t) => {
  const captured = mockModels(t);

  const { error } = await call(controller.createEmailMappings, {
    user: PM,
    validatedBody: { mappings: [{ team: 'WH', email: 'new@example.com' }] }
  });

  assert.equal(error, null);
  assert.deepEqual(captured.created, [{ team: 'WH', email: 'new@example.com' }]);
});

test('staff can add to any lab', async (t) => {
  const captured = mockModels(t);

  const { error } = await call(controller.createEmailMappings, {
    user: ADMIN,
    validatedBody: { mappings: [{ team: 'XC', email: 'new@example.com' }] }
  });

  assert.equal(error, null);
  assert.equal(captured.created.length, 1);
});

test('an unknown team is rejected before any scope check, for everyone', async (t) => {
  // A typo in a pasted roster must fail loudly rather than half-importing.
  mockModels(t);

  const { error } = await call(controller.createEmailMappings, {
    user: ADMIN,
    validatedBody: { mappings: [{ team: 'NOPE', email: 'x@example.com' }] }
  });

  assert.ok(error);
  assert.match(error.message, /Unknown team/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Deleting — the one that revokes access
// ─────────────────────────────────────────────────────────────────────────────

test('a PM cannot delete another lab\'s entry', async (t) => {
  let destroyed = false;
  mockModels(t, { mapping: { id: 'm1', team: 'XC', email: 'them@example.com', destroy: async () => { destroyed = true; } } });

  const { error } = await call(controller.deleteEmailMapping, { user: PM, params: { id: 'm1' } });

  assert.ok(error);
  assert.equal(destroyed, false, 'the entry must survive — deleting it revokes that account\'s membership');
});

test('the refusal does not reveal that the entry exists', async (t) => {
  // Not-found rather than forbidden: a PM probing ids should not be able to
  // enumerate another lab's roster by the difference in the reply.
  mockModels(t, { mapping: { id: 'm1', team: 'XC', email: 'them@example.com', destroy: async () => {} } });

  const outOfScope = await call(controller.deleteEmailMapping, { user: PM, params: { id: 'm1' } });

  mockModels(t, { mapping: null });
  const missing = await call(controller.deleteEmailMapping, { user: PM, params: { id: 'nope' } });

  assert.equal(outOfScope.error.constructor.name, missing.error.constructor.name);
  assert.equal(outOfScope.error.message, missing.error.message);
});

test('a PM can delete from their own lab', async (t) => {
  let destroyed = false;
  mockModels(t, { mapping: { id: 'm1', team: 'WH', email: 'ours@example.com', destroy: async () => { destroyed = true; } } });

  const { error } = await call(controller.deleteEmailMapping, { user: PM, params: { id: 'm1' } });

  assert.equal(error, null);
  assert.equal(destroyed, true);
});

test('staff can delete any entry', async (t) => {
  let destroyed = false;
  mockModels(t, { mapping: { id: 'm1', team: 'XC', email: 'them@example.com', destroy: async () => { destroyed = true; } } });

  const { error } = await call(controller.deleteEmailMapping, { user: ADMIN, params: { id: 'm1' } });

  assert.equal(error, null);
  assert.equal(destroyed, true);
});

test('deleting an entry that does not exist is a clean not-found', async (t) => {
  mockModels(t, { mapping: null });

  const { error } = await call(controller.deleteEmailMapping, { user: ADMIN, params: { id: 'nope' } });

  assert.ok(error);
  assert.match(error.message, /not found/i);
});
