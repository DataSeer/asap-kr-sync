/**
 * Tests for the request-validation schemas.
 * Run with: node --test src/backend/utils/validators.test.js
 *
 * Focus: the schemas added in Phase 3 (admin write endpoints) that
 * previously had no validation. Each schema is exercised on (a) a happy
 * path that should succeed, (b) at least one malformed input that should
 * throw a ValidationError.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('./validators');
const { ValidationError } = require('./errors');
const { ROLES } = require('../config/constants');

// Helper: assert that calling validate(name, payload) throws our typed
// ValidationError so consumers can rely on next(error) → 400 in the
// centralised error middleware.
function assertRejects(name, payload, expectedField) {
  let thrown;
  try {
    validate(name, payload);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, `expected validate(${name}) to throw`);
  assert.ok(
    thrown instanceof ValidationError,
    `expected ValidationError instance, got ${thrown.constructor?.name || typeof thrown}`
  );
  assert.equal(thrown.code, 'VALIDATION_ERROR');
  assert.equal(thrown.statusCode, 400);
  if (expectedField) {
    const fields = (thrown.errors || []).map(d => d.field);
    assert.ok(
      fields.some(f => f === expectedField || f.startsWith(`${expectedField}.`) || f.startsWith(`${expectedField}[`)),
      `expected error on field "${expectedField}", got fields: ${JSON.stringify(fields)}`
    );
  }
}

// ── createUser ────────────────────────────────────────────────────
test('createUser: happy path', () => {
  const v = validate('createUser', {
    email: 'JANE@EXAMPLE.COM',
    password: 'abc12345',
    name: 'Jane',
    role: ROLES.AUTHOR,
    teams: ['ML1']
  });
  assert.equal(v.email, 'jane@example.com'); // lowercased
  assert.equal(v.role, ROLES.AUTHOR);
  assert.deepEqual(v.teams, ['ML1']);
});

test('createUser: missing required password is rejected', () => {
  assertRejects('createUser', { email: 'a@b.com', name: 'Jane', role: ROLES.AUTHOR }, 'password');
});

test('createUser: object-typed password rejected (DoS prevention)', () => {
  // Without Joi, passing { length: 9999999 } as a "password" reached bcrypt
  // and could DoS the hasher. Schema must enforce string type.
  assertRejects('createUser', {
    email: 'a@b.com', password: { foo: 'bar' }, name: 'Jane', role: ROLES.AUTHOR
  }, 'password');
});

test('createUser: unknown role rejected', () => {
  assertRejects('createUser', {
    email: 'a@b.com', password: 'abc12345', name: 'Jane', role: 'super_admin'
  }, 'role');
});

test('createUser: oversized password rejected', () => {
  assertRejects('createUser', {
    email: 'a@b.com', password: 'a'.repeat(200) + '1', name: 'Jane', role: ROLES.AUTHOR
  }, 'password');
});

// ── updateUser ────────────────────────────────────────────────────
test('updateUser: empty body rejected (must touch at least one field)', () => {
  assertRejects('updateUser', {});
});

test('updateUser: partial update accepted', () => {
  const v = validate('updateUser', { name: 'New name' });
  assert.equal(v.name, 'New name');
});

// ── createTeam ────────────────────────────────────────────────────
test('createTeam: code is uppercased + trimmed', () => {
  const v = validate('createTeam', { code: '  ml1  ', name: 'Machine Learning' });
  assert.equal(v.code, 'ML1');
  assert.equal(v.name, 'Machine Learning');
});

test('createTeam: invalid code rejected', () => {
  assertRejects('createTeam', { code: 'ml 1!', name: 'x' }, 'code');
});

test('createTeam: name optional', () => {
  const v = validate('createTeam', { code: 'ML1' });
  assert.equal(v.code, 'ML1');
});

// ── updateProfile ─────────────────────────────────────────────────
test('updateProfile: newPassword without currentPassword rejected', () => {
  // The .with() rule in the schema enforces this dependency so the
  // controller never has to special-case it.
  assertRejects('updateProfile', { newPassword: 'newpw1234' });
});

test('updateProfile: newPassword + currentPassword accepted', () => {
  const v = validate('updateProfile', {
    currentPassword: 'oldpw',
    newPassword: 'newpw1234'
  });
  assert.equal(v.newPassword, 'newpw1234');
});

test('updateProfile: empty body rejected', () => {
  assertRejects('updateProfile', {});
});

// ── appConfigUpsert ───────────────────────────────────────────────
test('appConfigUpsert: string value accepted', () => {
  const v = validate('appConfigUpsert', { key: 'foo', value: 'bar' });
  assert.equal(v.value, 'bar');
});

test('appConfigUpsert: array value accepted', () => {
  const v = validate('appConfigUpsert', { key: 'foo', value: ['a', 'b'] });
  assert.deepEqual(v.value, ['a', 'b']);
});

test('appConfigUpsert: nested object value accepted', () => {
  const v = validate('appConfigUpsert', { key: 'foo', value: { nested: { deep: 1 } } });
  assert.deepEqual(v.value, { nested: { deep: 1 } });
});

test('appConfigUpsert: missing value rejected', () => {
  assertRejects('appConfigUpsert', { key: 'foo' }, 'value');
});

test('appConfigUpsert: missing key rejected', () => {
  assertRejects('appConfigUpsert', { value: 'bar' }, 'key');
});

// ── enrichmentListEntry ───────────────────────────────────────────
test('enrichmentListEntry: happy path', () => {
  const v = validate('enrichmentListEntry', {
    resourceType: 'antibody',
    resourceName: 'anti-GFP',
    identifier: 'RRID:AB_123'
  });
  assert.equal(v.resourceType, 'antibody');
  assert.deepEqual(v.tokens, []); // default applied
});

test('enrichmentListEntry: missing resourceName rejected', () => {
  assertRejects('enrichmentListEntry', { resourceType: 'antibody' }, 'resourceName');
});

test('enrichmentListEntry: tokens array of strings accepted', () => {
  const v = validate('enrichmentListEntry', {
    resourceType: 'antibody',
    resourceName: 'a',
    tokens: ['t1', 't2']
  });
  assert.deepEqual(v.tokens, ['t1', 't2']);
});

test('enrichmentListEntry: oversized tokens array rejected', () => {
  const tooMany = Array.from({ length: 201 }, (_, i) => `t${i}`);
  assertRejects('enrichmentListEntry', {
    resourceType: 'antibody', resourceName: 'a', tokens: tooMany
  }, 'tokens');
});

// ── updateEnrichmentListEntry (PATCH semantics) ───────────────────
test('updateEnrichmentListEntry: partial body accepted', () => {
  const v = validate('updateEnrichmentListEntry', { resourceName: 'new name' });
  assert.equal(v.resourceName, 'new name');
});

test('updateEnrichmentListEntry: empty body rejected', () => {
  assertRejects('updateEnrichmentListEntry', {});
});

// ── enrichmentListImport ──────────────────────────────────────────
test('enrichmentListImport: happy path with default mode', () => {
  const v = validate('enrichmentListImport', {
    entries: [{ resourceName: 'a' }]
  });
  assert.equal(v.mode, 'append'); // default
});

test('enrichmentListImport: empty entries rejected', () => {
  assertRejects('enrichmentListImport', { entries: [] }, 'entries');
});

test('enrichmentListImport: invalid mode rejected', () => {
  assertRejects('enrichmentListImport', {
    entries: [{ resourceName: 'a' }], mode: 'truncate'
  }, 'mode');
});

// ── approveSuggestion / rejectSuggestion ──────────────────────────
test('approveSuggestion: happy path', () => {
  const v = validate('approveSuggestion', { suggestionId: 'sg-123', modifiedValue: 'foo' });
  assert.equal(v.suggestionId, 'sg-123');
});

test('approveSuggestion: missing suggestionId rejected', () => {
  assertRejects('approveSuggestion', {}, 'suggestionId');
});

test('rejectSuggestion: reason optional', () => {
  const v = validate('rejectSuggestion', { suggestionId: 'sg-123' });
  assert.equal(v.suggestionId, 'sg-123');
});

// ── generateReport ────────────────────────────────────────────────
test('generateReport: defaults type to excel', () => {
  const v = validate('generateReport', {});
  assert.equal(v.type, 'excel');
});

test('generateReport: invalid type rejected', () => {
  assertRejects('generateReport', { type: 'word' }, 'type');
});

test('generateReport: pdf type accepted', () => {
  const v = validate('generateReport', { type: 'pdf' });
  assert.equal(v.type, 'pdf');
});

// ── stripUnknown is enabled (defense-in-depth) ────────────────────
test('schemas strip unknown fields', () => {
  // The middleware uses stripUnknown:true so even if a controller forgot to
  // read from req.validatedBody, attempting to mass-assign unknown columns
  // through one of these schemas wouldn't surface them.
  const v = validate('createUser', {
    email: 'a@b.com',
    password: 'abc12345',
    name: 'Jane',
    role: ROLES.AUTHOR,
    isAdmin: true,           // sneaky extra field
    passwordHash: 'evil'      // direct hash injection attempt
  });
  assert.equal(v.isAdmin, undefined);
  assert.equal(v.passwordHash, undefined);
});

test('register: rejects client-supplied role/team (privilege escalation guard)', () => {
  // Self-signup must never let the caller pick their role. The register schema
  // does not declare role/team, so stripUnknown drops them; the service then
  // forces role='author'. This guards against escalation via POST /auth/register.
  const v = validate('register', {
    email: 'a@b.com',
    password: 'abc12345',
    name: 'Jane',
    role: ROLES.ADMIN,   // escalation attempt
    team: 'WH'
  });
  assert.equal(v.role, undefined);
  assert.equal(v.team, undefined);
  assert.deepEqual(Object.keys(v).sort(), ['email', 'name', 'password']);
});
