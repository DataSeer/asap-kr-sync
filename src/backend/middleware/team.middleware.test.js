/**
 * Tests for the team-based access control middleware — the authoritative
 * server-side visibility rules for submissions.
 * Run with: node --test src/backend/middleware/team.middleware.test.js
 *
 * Visibility is derived from the OWNER's teams: a PM sees submissions whose
 * owner shares one of the PM's teams. The project (2-letter code) is a filter
 * only and never appears here.
 *
 * Models are required without a live DB (Sequelize connects lazily); every
 * query method used by the middleware is mocked per-test.
 */

const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { User, UserTeam, Submission } = require('../models');
const { buildSubmissionFilter, canAccessSubmission } = require('./team.middleware');
const { AuthorizationError } = require('../utils/errors');

// Defaults: no staff users, no staff-owned submissions, owner shares no team.
beforeEach(() => {
  mock.method(User, 'findAll', async () => []);
  mock.method(User, 'count', async () => 0);
  mock.method(UserTeam, 'count', async () => 0);
});
afterEach(() => mock.restoreAll());

const pm = (teams, id = 'pm-1') => ({ id, role: 'asap_pm', teams });

// ── buildSubmissionFilter ────────────────────────────────────────────

test('filter: admin and ds_annotator see everything', async () => {
  assert.deepEqual(await buildSubmissionFilter({ id: 'u', role: 'admin', teams: [] }), {});
  assert.deepEqual(await buildSubmissionFilter({ id: 'u', role: 'ds_annotator', teams: [] }), {});
});

test('filter: author sees only own submissions', async () => {
  assert.deepEqual(await buildSubmissionFilter({ id: 'au-1', role: 'author', teams: [] }), { userId: 'au-1' });
});

test('filter: missing user or unknown role sees nothing', async () => {
  assert.deepEqual(await buildSubmissionFilter(null), { id: null });
  assert.deepEqual(await buildSubmissionFilter({ id: 'u', role: 'intruder', teams: [] }), { id: null });
});

test('filter: PM with no teams sees only their own submissions', async () => {
  const filter = await buildSubmissionFilter(pm([]));
  assert.deepEqual(filter.userId[Op.in], ['pm-1']);
});

test('filter: PM sees own + teammates (owners on the same team)', async () => {
  mock.method(UserTeam, 'findAll', async () => [
    { userId: 'pm-1' }, { userId: 'mate-1' }, { userId: 'mate-2' }, { userId: 'mate-1' }
  ]);

  const filter = await buildSubmissionFilter(pm(['Harper', 'Wood']));
  const ids = filter.userId[Op.in];

  assert.ok(ids.includes('pm-1'));
  assert.ok(ids.includes('mate-1'));
  assert.ok(ids.includes('mate-2'));
  assert.equal(new Set(ids).size, ids.length, 'owner ids are deduplicated');

  // teammates looked up across the PM's teams
  const where = UserTeam.findAll.mock.calls[0].arguments[0].where;
  assert.deepEqual(where.team[Op.in], ['Harper', 'Wood']);
});

test('filter: PM filter excludes staff-owned submissions', async () => {
  mock.method(UserTeam, 'findAll', async () => [{ userId: 'mate-1' }]);
  mock.method(User, 'findAll', async () => [{ id: 'admin-1' }, { id: 'ds-1' }]);

  const filter = await buildSubmissionFilter(pm(['Harper']));

  const and = filter[Op.and];
  assert.ok(Array.isArray(and) && and.length === 2);
  assert.ok(and[0].userId[Op.in].includes('pm-1'));
  assert.deepEqual(and[1].userId[Op.notIn], ['admin-1', 'ds-1']);
});

// ── canAccessSubmission ──────────────────────────────────────────────

async function runAccess(user, submission) {
  mock.method(Submission, 'findByPk', async () => submission);
  const req = { user, params: { id: 'sub-1' } };
  let nextArg;
  await canAccessSubmission(req, {}, (arg) => { nextArg = arg; });
  return { req, nextArg };
}

test('access: admin/ds reach any submission', async () => {
  for (const role of ['admin', 'ds_annotator']) {
    const { nextArg } = await runAccess({ id: 'x', role, teams: [] }, { id: 'sub-1', userId: 'other' });
    assert.equal(nextArg, undefined);
  }
});

test('access: PM reaches their own submission', async () => {
  const sub = { id: 'sub-1', userId: 'pm-1', project: 'WH' };
  const { req, nextArg } = await runAccess(pm(['Harper']), sub);
  assert.equal(nextArg, undefined);
  assert.equal(req.submission, sub);
});

test('access: PM reaches a submission whose owner shares their team', async () => {
  mock.method(UserTeam, 'count', async () => 1);
  const { nextArg } = await runAccess(pm(['Harper']), { id: 'sub-1', userId: 'mate-1', project: 'WH' });
  assert.equal(nextArg, undefined);
  const where = UserTeam.count.mock.calls[0].arguments[0].where;
  assert.equal(where.userId, 'mate-1');
  assert.deepEqual(where.team[Op.in], ['Harper']);
});

test('access: PM is denied when the owner shares no team', async () => {
  mock.method(UserTeam, 'count', async () => 0);
  const { nextArg } = await runAccess(pm(['Harper']), { id: 'sub-1', userId: 'stranger', project: 'WH' });
  assert.ok(nextArg instanceof AuthorizationError);
});

test('access: PM is denied on a staff-owned submission even if same team', async () => {
  mock.method(User, 'count', async () => 1);        // owner is staff
  mock.method(UserTeam, 'count', async () => 1);    // and would share a team
  const { nextArg } = await runAccess(pm(['Harper']), { id: 'sub-1', userId: 'admin-1', project: 'WH' });
  assert.ok(nextArg instanceof AuthorizationError);
});

test('access: PM with no teams is denied on someone else\'s submission', async () => {
  const { nextArg } = await runAccess(pm([]), { id: 'sub-1', userId: 'stranger', project: 'WH' });
  assert.ok(nextArg instanceof AuthorizationError);
});

test('access: author reaches own submission, denied on others\'', async () => {
  const author = { id: 'au-1', role: 'author', teams: [] };
  assert.equal((await runAccess(author, { id: 'sub-1', userId: 'au-1', project: 'WH' })).nextArg, undefined);
  assert.ok((await runAccess(author, { id: 'sub-1', userId: 'other', project: 'WH' })).nextArg instanceof AuthorizationError);
});
