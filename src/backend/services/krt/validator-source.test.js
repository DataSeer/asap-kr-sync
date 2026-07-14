'use strict';

/**
 * Focused tests for the "Source is optional for Software/code rows that already
 * carry an identifier" rule (validateSource). Pure function — no DB needed.
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateSource } = require('./validator.service');

function sourceRequired(errors) {
  return errors.some(e => e.columnName === 'SOURCE' && e.errorType === 'required');
}

test('empty Source is required for a non-software row even with an identifier', () => {
  const errors = validateSource('', 'r1', { resourceType: 'Dataset', identifier: '10.5281/zenodo.123' });
  assert.equal(sourceRequired(errors), true);
});

test('empty Source is required for Software/code with NO identifier', () => {
  const errors = validateSource('', 'r1', { resourceType: 'Software/code', identifier: '' });
  assert.equal(sourceRequired(errors), true);
});

test('empty Source is NOT required for Software/code that has an identifier', () => {
  const errors = validateSource('', 'r1', { resourceType: 'Software/code', identifier: 'RRID:SCR_002285' });
  assert.equal(errors.length, 0);
});

test('any identifier value counts, not just an RRID (e.g. a URL)', () => {
  const errors = validateSource('', 'r1', { resourceType: 'Software/code', identifier: 'https://github.com/x/y' });
  assert.equal(errors.length, 0);
});

test('escape hatches do NOT count as a provided identifier', () => {
  for (const id of ['No identifier exists', 'Identifier pending', 'N/A', 'none', '-']) {
    const errors = validateSource('', 'r1', { resourceType: 'Software/code', identifier: id });
    assert.equal(sourceRequired(errors), true, `expected Source required for identifier "${id}"`);
  }
});

test('a filled Source never triggers the required error', () => {
  const errors = validateSource('GitHub', 'r1', { resourceType: 'Software/code', identifier: '' });
  assert.equal(sourceRequired(errors), false);
});
