/**
 * Turning an uploaded spreadsheet into KRT rows.
 *
 * This runs before any validation, so whatever it drops or mangles is simply
 * gone by the time a curator looks. The two behaviours worth guarding are the
 * ones that DELETE data — the empty-row skip and the section-header skip — and
 * the column aliasing, which decides whether a real column is read at all or
 * silently becomes an empty string.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRows, validateColumns } = require('./parser.service');

const full = (over = {}) => ({
  'RESOURCE TYPE': 'Antibody',
  'RESOURCE NAME': 'anti-TagFP',
  'SOURCE': 'Evrogen',
  'IDENTIFIER': 'RRID:AB_2313584',
  'NEW/REUSE': 'reuse',
  'ADDITIONAL INFORMATION': '',
  ...over
});

// ─────────────────────────────────────────────────────────────────────────────
// Column aliasing — a column read under the wrong name is data lost
// ─────────────────────────────────────────────────────────────────────────────

test('the canonical headers pass through unchanged', () => {
  const [row] = normalizeRows([full()]);
  assert.equal(row['RESOURCE NAME'], 'anti-TagFP');
  assert.equal(row['IDENTIFIER'], 'RRID:AB_2313584');
  assert.equal(row['NEW/REUSE'], 'reuse');
});

test('the accepted header variations all land in the right column', () => {
  const [row] = normalizeRows([{
    TYPE: 'Antibody', NAME: 'anti-TagFP', PROVIDER: 'Evrogen',
    DOI: '10.5281/zenodo.1', STATUS: 'new', NOTES: 'from the freezer'
  }]);
  assert.equal(row['RESOURCE TYPE'], 'Antibody');
  assert.equal(row['RESOURCE NAME'], 'anti-TagFP');
  assert.equal(row['SOURCE'], 'Evrogen');
  assert.equal(row['IDENTIFIER'], '10.5281/zenodo.1');
  assert.equal(row['NEW/REUSE'], 'new');
  assert.equal(row['ADDITIONAL INFORMATION'], 'from the freezer');
});

test('a column the mapping does not know becomes empty, never undefined', () => {
  // Downstream code indexes these by name; undefined would read as a missing
  // property rather than an empty cell.
  const [row] = normalizeRows([{ 'RESOURCE NAME': 'x', 'UNKNOWN COLUMN': 'ignored' }]);
  for (const column of ['RESOURCE TYPE', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION']) {
    assert.equal(row[column], '', `${column} must be an empty string`);
  }
});

test('values are trimmed and coerced to strings', () => {
  const [row] = normalizeRows([full({ 'RESOURCE NAME': '  spaced  ', 'IDENTIFIER': 12345 })]);
  assert.equal(row['RESOURCE NAME'], 'spaced');
  assert.equal(row['IDENTIFIER'], '12345', 'a numeric cell must not arrive as a number');
});

test('a null or undefined cell becomes an empty string', () => {
  const [row] = normalizeRows([full({ 'SOURCE': null, 'ADDITIONAL INFORMATION': undefined })]);
  assert.equal(row['SOURCE'], '');
  assert.equal(row['ADDITIONAL INFORMATION'], '');
});

// ─────────────────────────────────────────────────────────────────────────────
// What gets dropped
// ─────────────────────────────────────────────────────────────────────────────

test('a blank row is dropped', () => {
  const rows = normalizeRows([full(), {
    'RESOURCE TYPE': '', 'RESOURCE NAME': '', 'SOURCE': '',
    'IDENTIFIER': '', 'NEW/REUSE': '', 'ADDITIONAL INFORMATION': ''
  }]);
  assert.equal(rows.length, 1);
});

test('a row of nothing but spaces is dropped too', () => {
  const rows = normalizeRows([{ 'RESOURCE NAME': '   ', 'SOURCE': '  ' }]);
  assert.equal(rows.length, 0);
});

test('a section-header row — a lone resource-type label — is dropped', () => {
  // Authors write "Antibody" on its own line before listing antibodies under
  // it. Imported literally, each becomes an empty row for the curator to delete.
  const rows = normalizeRows([
    { 'RESOURCE TYPE': 'Antibody', 'RESOURCE NAME': '', 'SOURCE': '', 'IDENTIFIER': '' },
    full()
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['RESOURCE NAME'], 'anti-TagFP');
});

test('a section header written as a synonym is also dropped', () => {
  const rows = normalizeRows([{ 'RESOURCE TYPE': 'Antibodies', 'RESOURCE NAME': '' }]);
  assert.equal(rows.length, 0);
});

test('a real row is NEVER dropped for having only a type and a name', () => {
  // The header rule must require the rest to be blank — otherwise it eats data.
  const rows = normalizeRows([{ 'RESOURCE TYPE': 'Antibody', 'RESOURCE NAME': 'anti-TagFP' }]);
  assert.equal(rows.length, 1, 'a named resource is a row, whatever else is missing');
});

test('a row whose lone value is not a resource type is kept', () => {
  const rows = normalizeRows([{ 'RESOURCE TYPE': 'Some free text', 'RESOURCE NAME': '' }]);
  assert.equal(rows.length, 1, 'only recognised type labels are section headers');
});

test('a row carrying only an identifier is kept', () => {
  // Incomplete, but the curator needs to see it to fix it — dropping it hides
  // the problem.
  const rows = normalizeRows([{ 'IDENTIFIER': 'RRID:AB_2313584' }]);
  assert.equal(rows.length, 1);
});

test('normalizeRows survives an empty input', () => {
  assert.deepEqual(normalizeRows([]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateColumns — whether the file is a KRT at all
// ─────────────────────────────────────────────────────────────────────────────

test('a file with every required column is valid', () => {
  const result = validateColumns([full()]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missingColumns, []);
});

test('ADDITIONAL INFORMATION is not required', () => {
  const row = full();
  delete row['ADDITIONAL INFORMATION'];
  assert.equal(validateColumns([row]).valid, true);
});

test('a missing required column is named, so the message can say which', () => {
  const row = full();
  delete row['IDENTIFIER'];
  const result = validateColumns([row]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingColumns, ['IDENTIFIER']);
});

test('headers are matched regardless of case and spacing', () => {
  const result = validateColumns({ headers: [
    'resource type', '  RESOURCE   NAME ', 'Source', 'identifier', 'new/reuse'
  ] });
  assert.equal(result.valid, true, `unexpectedly missing: ${result.missingColumns}`);
});

test('an explicit header list is preferred over the first row\'s keys', () => {
  // A file whose first data row happens to omit a column must still validate on
  // its real headers.
  const result = validateColumns({ headers: [
    'RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE'
  ] });
  assert.equal(result.valid, true);
});

test('an empty file is invalid and reports every column as missing', () => {
  const result = validateColumns([]);
  assert.equal(result.valid, false);
  assert.ok(result.missingColumns.length > 0);
});
