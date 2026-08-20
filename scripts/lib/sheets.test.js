/**
 * The spreadsheet helpers the scripts read and write through.
 *
 * They exist to replace `xlsx` (SheetJS), which carries two unfixed
 * high-severity advisories and has no fixed version on npm at all. Behaviour
 * has to match what the scripts relied on, because a silent difference here
 * shows up as a benchmark that reads 1200 protocols instead of 12, or a column
 * of DOIs exported as "[object Object]".
 *
 * Round-trip through a real file rather than a mock: the point is that exceljs
 * produces something exceljs can read back, and that empty cells, formulas and
 * hyperlinks survive as the text a reader would see.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sheets = require('./sheets');

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-')), name);

test('rows of objects round-trip through a file', async () => {
  const file = tmpFile('round-trip.xlsx');
  const wb = sheets.newWorkbook();
  sheets.addObjectSheet(wb, 'real', [
    { Name: 'CellProfiler', Identifier: 'RRID:SCR_007358' },
    { Name: 'Fiji', Identifier: '' }
  ]);
  await sheets.writeWorkbook(wb, file);

  const back = await sheets.readWorkbook(file);
  const rows = sheets.sheetToObjects(back.getWorksheet('real'));

  assert.deepEqual(rows, [
    { Name: 'CellProfiler', Identifier: 'RRID:SCR_007358' },
    { Name: 'Fiji', Identifier: '' }
  ]);
});

test('an explicit header fixes the column order', async () => {
  // Without it the order falls out of key iteration, and a file silently
  // reorders itself between runs.
  const file = tmpFile('order.xlsx');
  const wb = sheets.newWorkbook();
  sheets.addObjectSheet(wb, 's', [{ b: '2', a: '1' }], { header: ['a', 'b'] });
  await sheets.writeWorkbook(wb, file);

  const back = await sheets.readWorkbook(file);
  assert.deepEqual(sheets.sheetToRows(back.getWorksheet('s'))[0], ['a', 'b']);
});

test('a row missing a key is written blank, not skipped', async () => {
  const file = tmpFile('sparse.xlsx');
  const wb = sheets.newWorkbook();
  sheets.addObjectSheet(wb, 's', [{ a: '1' }, { a: '2', b: 'x' }], { header: ['a', 'b'] });
  await sheets.writeWorkbook(wb, file);

  const back = await sheets.readWorkbook(file);
  const rows = sheets.sheetToObjects(back.getWorksheet('s'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].b, '');
});

test('blank padding rows are not read as records', async () => {
  // A sheet with trailing formatting reports a rowCount past its data. Keeping
  // those turns "12 protocols" into "1200 protocols".
  const file = tmpFile('padding.xlsx');
  const wb = sheets.newWorkbook();
  const sheet = sheets.addObjectSheet(wb, 's', [{ a: '1' }], { header: ['a'] });
  sheet.getRow(50).getCell(1).value = null;
  sheet.getRow(50).commit();
  await sheets.writeWorkbook(wb, file);

  const back = await sheets.readWorkbook(file);
  assert.equal(sheets.sheetToObjects(back.getWorksheet('s')).length, 1);
});

test('defval controls what an empty cell reads as', async () => {
  const file = tmpFile('defval.xlsx');
  const wb = sheets.newWorkbook();
  sheets.addObjectSheet(wb, 's', [{ a: '1', b: '' }], { header: ['a', 'b'] });
  await sheets.writeWorkbook(wb, file);

  const back = await sheets.readWorkbook(file);
  const rows = sheets.sheetToObjects(back.getWorksheet('s'), { defval: null });
  assert.equal(rows[0].b, null);
});

// ── cellText: the values that are not plain strings ─────────────────────────
//
// exceljs returns rich objects for these, and a bare `cell.value` renders them
// as "[object Object]" — which is how a column of identifiers becomes a column
// of nothing.

test('a hyperlink reads as its text', () => {
  const cell = { value: { text: '10.5281/zenodo.1', hyperlink: 'https://doi.org/10.5281/zenodo.1' } };
  assert.equal(sheets.cellText(cell), '10.5281/zenodo.1');
});

test('rich text reads as the concatenated runs', () => {
  const cell = { value: { richText: [{ text: 'RRID:' }, { text: 'AB_123' }] } };
  assert.equal(sheets.cellText(cell), 'RRID:AB_123');
});

test('a formula reads as its computed result', () => {
  assert.equal(sheets.cellText({ value: { formula: 'A1&B1', result: 'joined' } }), 'joined');
});

test('a formula error reads as empty, not as the error object', () => {
  assert.equal(sheets.cellText({ value: { error: '#REF!' } }), '');
});

test('an empty cell is the empty string, never "null"', () => {
  assert.equal(sheets.cellText({ value: null }), '');
  assert.equal(sheets.cellText({}), '');
  assert.equal(sheets.cellText(undefined), '');
});

test('a number reads as its digits', () => {
  // Catalogue numbers arrive as numbers and must not become "657012.0" or NaN.
  assert.equal(sheets.cellText({ value: 657012 }), '657012');
});

test('a CSV is read as a single sheet', async () => {
  const file = tmpFile('in.csv');
  fs.writeFileSync(file, 'Name,Identifier\nFiji,RRID:SCR_002285\n');

  const wb = await sheets.readWorkbook(file);
  const rows = sheets.sheetToObjects(wb.worksheets[0]);

  assert.deepEqual(rows, [{ Name: 'Fiji', Identifier: 'RRID:SCR_002285' }]);
});

test('a missing sheet is an empty list, not a crash', () => {
  assert.deepEqual(sheets.sheetToObjects(undefined), []);
  assert.deepEqual(sheets.sheetToRows(null), []);
});
