/**
 * Tests for the team-email roster service (automatic team assignment).
 * Run with: node --test src/backend/services/teams/team-email.service.test.js
 *
 * Models are required without a live DB (Sequelize connects lazily); every
 * query method used by the service is mocked per-test.
 */

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { TeamEmail, UserTeam, User } = require('../../models');
const { applyMappingsForUser, applyMappingToExistingUser } = require('./team-email.service');

afterEach(() => mock.restoreAll());

test('applyMappingsForUser: creates only the missing memberships, returns all mapped teams', async () => {
  mock.method(TeamEmail, 'findAll', async () => [{ team: 'WH' }, { team: 'ML' }, { team: 'WH' }]);
  mock.method(UserTeam, 'findAll', async () => [{ team: 'WH' }]);
  const bulkCreate = mock.method(UserTeam, 'bulkCreate', async () => []);

  const teams = await applyMappingsForUser('u-1', 'Jane.Doe@Example.org');

  assert.deepEqual(teams, ['WH', 'ML']);
  // roster looked up with the normalized email
  assert.equal(TeamEmail.findAll.mock.calls[0].arguments[0].where.email, 'jane.doe@example.org');
  // only the missing membership is created, race-safe
  assert.deepEqual(bulkCreate.mock.calls[0].arguments[0], [{ userId: 'u-1', team: 'ML' }]);
  assert.equal(bulkCreate.mock.calls[0].arguments[1].ignoreDuplicates, true);
});

test('applyMappingsForUser: no roster entries → no writes, empty result', async () => {
  mock.method(TeamEmail, 'findAll', async () => []);
  const bulkCreate = mock.method(UserTeam, 'bulkCreate', async () => []);

  assert.deepEqual(await applyMappingsForUser('u-1', 'nobody@example.org'), []);
  assert.equal(bulkCreate.mock.callCount(), 0);
});

test('applyMappingsForUser: all memberships already exist → no writes', async () => {
  mock.method(TeamEmail, 'findAll', async () => [{ team: 'WH' }]);
  mock.method(UserTeam, 'findAll', async () => [{ team: 'WH' }]);
  const bulkCreate = mock.method(UserTeam, 'bulkCreate', async () => []);

  assert.deepEqual(await applyMappingsForUser('u-1', 'jane@example.org'), ['WH']);
  assert.equal(bulkCreate.mock.callCount(), 0);
});

test('applyMappingsForUser: never throws (auth flows call it inline)', async () => {
  mock.method(TeamEmail, 'findAll', async () => { throw new Error('db down'); });
  assert.deepEqual(await applyMappingsForUser('u-1', 'jane@example.org'), []);
  assert.deepEqual(await applyMappingsForUser(null, 'jane@example.org'), []);
  assert.deepEqual(await applyMappingsForUser('u-1', null), []);
});

test('applyMappingToExistingUser: assigns when the user exists', async () => {
  mock.method(User, 'findOne', async () => ({ id: 'u-9' }));
  mock.method(UserTeam, 'findOrCreate', async () => [{}, true]);

  assert.equal(await applyMappingToExistingUser('WH', 'Jane@Example.org'), true);
  assert.equal(User.findOne.mock.calls[0].arguments[0].where.email, 'jane@example.org');
  assert.deepEqual(UserTeam.findOrCreate.mock.calls[0].arguments[0], { where: { userId: 'u-9', team: 'WH' } });
});

test('applyMappingToExistingUser: false when no user or membership already present', async () => {
  mock.method(User, 'findOne', async () => null);
  assert.equal(await applyMappingToExistingUser('WH', 'ghost@example.org'), false);

  mock.restoreAll();
  mock.method(User, 'findOne', async () => ({ id: 'u-9' }));
  mock.method(UserTeam, 'findOrCreate', async () => [{}, false]);
  assert.equal(await applyMappingToExistingUser('WH', 'jane@example.org'), false);
});
