'use strict';

/**
 * Tests for the KRT import changes requested in the ASAP report evaluations:
 * dropping author "header" rows (a bare resource-type name entered as its own
 * row), and defaulting Software/code rows with a blank NEW/REUSE to "reuse".
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeRows } = require('./parser.service');

function row(overrides = {}) {
  return {
    'RESOURCE TYPE': '', 'RESOURCE NAME': '', 'SOURCE': '',
    'IDENTIFIER': '', 'NEW/REUSE': '', 'ADDITIONAL INFORMATION': '',
    ...overrides
  };
}

test('a bare resource-type "header" row is dropped on import', () => {
  const out = normalizeRows([
    row({ 'RESOURCE TYPE': 'Antibody' }),
    row({ 'RESOURCE TYPE': 'Antibody', 'RESOURCE NAME': 'anti-GFP', 'IDENTIFIER': 'AB_2617428' })
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]['RESOURCE NAME'], 'anti-GFP');
});

test('a header row using an author synonym is also dropped', () => {
  const out = normalizeRows([row({ 'RESOURCE TYPE': 'Virus strain' })]);
  assert.equal(out.length, 0);
});

test('a row with a real name but no type is kept (not a header)', () => {
  const out = normalizeRows([row({ 'RESOURCE NAME': 'Some incomplete resource' })]);
  assert.equal(out.length, 1);
});

test('a resource-type-only row whose value is not a known type is kept', () => {
  const out = normalizeRows([row({ 'RESOURCE TYPE': 'Widget' })]);
  assert.equal(out.length, 1);
});

test('Software/code rows with a blank NEW/REUSE default to "reuse"', () => {
  const out = normalizeRows([
    row({ 'RESOURCE TYPE': 'Software', 'RESOURCE NAME': 'ImageJ', 'IDENTIFIER': 'RRID:SCR_003070' })
  ]);
  assert.equal(out[0]['NEW/REUSE'], 'reuse');
});

test('an explicit NEW/REUSE value on a Software row is never overridden', () => {
  const out = normalizeRows([
    row({ 'RESOURCE TYPE': 'Software', 'RESOURCE NAME': 'MyTool', 'SOURCE': 'x', 'NEW/REUSE': 'new' })
  ]);
  assert.equal(out[0]['NEW/REUSE'], 'new');
});

test('non-software rows are not given a default NEW/REUSE', () => {
  const out = normalizeRows([
    row({ 'RESOURCE TYPE': 'Antibody', 'RESOURCE NAME': 'anti-GFP', 'IDENTIFIER': 'AB_2617428' })
  ]);
  assert.equal(out[0]['NEW/REUSE'], '');
});

test('"Software" and "Code" are auto-converted to the canonical "Software/code"', () => {
  const out = normalizeRows([
    row({ 'RESOURCE TYPE': 'Software', 'RESOURCE NAME': 'ImageJ', 'IDENTIFIER': 'RRID:SCR_003070' }),
    row({ 'RESOURCE TYPE': 'Code', 'RESOURCE NAME': 'MyScript', 'SOURCE': 'GitHub', 'NEW/REUSE': 'new' })
  ]);
  assert.equal(out[0]['RESOURCE TYPE'], 'Software/code');
  assert.equal(out[1]['RESOURCE TYPE'], 'Software/code');
  assert.equal(out[1]['NEW/REUSE'], 'new'); // explicit value preserved
});

test('a non-software synonym is NOT auto-converted (left for curator confirmation)', () => {
  const out = normalizeRows([
    row({ 'RESOURCE TYPE': 'Chemicals', 'RESOURCE NAME': 'DMSO', 'IDENTIFIER': '67-68-5' })
  ]);
  assert.equal(out[0]['RESOURCE TYPE'], 'Chemicals');
});
