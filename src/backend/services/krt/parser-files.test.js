/**
 * Reading the file an author actually uploads.
 *
 * Everything downstream — validation, seeding, the Generated KRT — is built on
 * whatever comes out of here, and a spreadsheet exported from Excel, Google
 * Sheets or a text editor differs in delimiter, encoding and line endings
 * without the author being aware of any of it. A parse that quietly returns
 * fewer rows than the file contains is the worst outcome, so most of these
 * assert on row COUNT and content rather than on not throwing.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { parseFile, parseCSV, parseExcel } = require('./parser.service');

const HEADER = 'RESOURCE TYPE,RESOURCE NAME,SOURCE,IDENTIFIER,NEW/REUSE,ADDITIONAL INFORMATION';
const ROW = 'Antibody,anti-TagFP,Evrogen,RRID:AB_2313584,reuse,';
const csv = (...lines) => Buffer.from([HEADER, ...lines].join('\n'), 'utf-8');

async function xlsxBuffer(rows, { sheetName = 'KRT' } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const HEADER_CELLS = ['RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION'];
const ROW_CELLS = ['Antibody', 'anti-TagFP', 'Evrogen', 'RRID:AB_2313584', 'reuse', ''];

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

test('a plain comma CSV parses to one row per data line', async () => {
  const rows = await parseCSV(csv(ROW, 'Dataset,RNA-seq,GEO,GSE1,new,'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['RESOURCE NAME'], 'anti-TagFP');
  assert.equal(rows[1]['RESOURCE NAME'], 'RNA-seq');
});

test('the headers travel with the rows, for column validation', async () => {
  const rows = await parseCSV(csv(ROW));
  assert.ok(Array.isArray(rows.headers), 'headers must be attached to the result');
  assert.ok(rows.headers.includes('RESOURCE NAME'));
});

test('Windows line endings do not produce empty or broken rows', async () => {
  const buffer = Buffer.from([HEADER, ROW, 'Dataset,RNA-seq,GEO,GSE1,new,'].join('\r\n'), 'utf-8');
  const rows = await parseCSV(buffer);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]['IDENTIFIER'], 'GSE1');
});

test('a semicolon-delimited export is read, not mangled into one column', async () => {
  // What a European Excel writes by default. Papa auto-detects the delimiter.
  const buffer = Buffer.from([
    HEADER.replace(/,/g, ';'),
    ROW.replace(/,/g, ';')
  ].join('\n'), 'utf-8');

  const rows = await parseCSV(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]['RESOURCE NAME'], 'anti-TagFP');
  assert.equal(rows[0]['SOURCE'], 'Evrogen');
});

test('a tab-separated export is read too', async () => {
  const buffer = Buffer.from([
    HEADER.replace(/,/g, '\t'),
    ROW.replace(/,/g, '\t')
  ].join('\n'), 'utf-8');

  const rows = await parseCSV(buffer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['IDENTIFIER'], 'RRID:AB_2313584');
});

test('a quoted cell containing a comma stays one value', async () => {
  const rows = await parseCSV(csv('Antibody,"anti-TagFP, clone 3B2",Evrogen,RRID:AB_1,reuse,'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['RESOURCE NAME'], 'anti-TagFP, clone 3B2');
});

test('a quoted cell containing a newline stays one row', async () => {
  const rows = await parseCSV(csv('Antibody,anti-TagFP,Evrogen,RRID:AB_1,reuse,"line one\nline two"'));
  assert.equal(rows.length, 1, 'an embedded newline must not split the row');
  assert.match(rows[0]['ADDITIONAL INFORMATION'], /line one\nline two/);
});

test('trailing blank lines do not become rows', async () => {
  const buffer = Buffer.from([HEADER, ROW, '', '', ''].join('\n'), 'utf-8');
  assert.equal((await parseCSV(buffer)).length, 1);
});

test('a header-only file parses to no rows rather than failing', async () => {
  // This is the valid "empty KRT" the app itself exports and accepts.
  const rows = await parseCSV(csv());
  assert.equal(rows.length, 0);
  assert.ok(rows.headers.includes('RESOURCE TYPE'), 'its headers still have to arrive');
});

test('non-ASCII content survives the round trip', async () => {
  const rows = await parseCSV(csv('Antibody,anti-β-tubulin,Sigma–Aldrich,RRID:AB_1,reuse,incubated at 4 °C'));
  assert.equal(rows[0]['RESOURCE NAME'], 'anti-β-tubulin');
  assert.equal(rows[0]['SOURCE'], 'Sigma–Aldrich');
  assert.match(rows[0]['ADDITIONAL INFORMATION'], /4 °C/);
});

test('a UTF-8 BOM does not corrupt the first column name', async () => {
  // Excel writes one, and it used to arrive glued to the first header, which
  // made RESOURCE TYPE unreadable for every row in the file.
  const buffer = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), csv(ROW)]);
  const rows = await parseCSV(buffer);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]['RESOURCE TYPE'], 'Antibody');
});

// ─────────────────────────────────────────────────────────────────────────────
// XLSX
// ─────────────────────────────────────────────────────────────────────────────

test('an xlsx parses to one row per data row', async () => {
  const buffer = await xlsxBuffer([HEADER_CELLS, ROW_CELLS, ['Dataset', 'RNA-seq', 'GEO', 'GSE1', 'new', '']]);
  const rows = await parseExcel(buffer);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]['RESOURCE NAME'], 'anti-TagFP');
  assert.equal(rows[1]['SOURCE'], 'GEO');
});

test('a numeric cell arrives as a string, not a number', async () => {
  // Catalog numbers are frequently numeric, and downstream code treats every
  // cell as text.
  const buffer = await xlsxBuffer([HEADER_CELLS, ['Antibody', 'anti-TagFP', 'Evrogen', 12345, 'reuse', '']]);
  const rows = await parseExcel(buffer);

  assert.equal(rows[0]['IDENTIFIER'], '12345');
});

test('a blank row in the middle of the sheet is skipped, not carried', async () => {
  const buffer = await xlsxBuffer([HEADER_CELLS, ROW_CELLS, [], ['Dataset', 'RNA-seq', 'GEO', 'GSE1', 'new', '']]);
  const rows = await parseExcel(buffer);

  assert.equal(rows.length, 2);
});

test('an xlsx with only headers parses to no rows', async () => {
  const rows = await parseExcel(await xlsxBuffer([HEADER_CELLS]));
  assert.equal(rows.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Choosing the parser, and refusing what cannot be read
// ─────────────────────────────────────────────────────────────────────────────

test('the extension decides the parser', async () => {
  const fromCsv = await parseFile(csv(ROW), 'text/csv', 'krt.csv');
  const fromXlsx = await parseFile(await xlsxBuffer([HEADER_CELLS, ROW_CELLS]), 'application/xlsx', 'krt.xlsx');

  assert.equal(fromCsv[0]['RESOURCE NAME'], 'anti-TagFP');
  assert.equal(fromXlsx[0]['RESOURCE NAME'], 'anti-TagFP');
});

test('the extension is matched case-insensitively', async () => {
  const rows = await parseFile(csv(ROW), 'text/csv', 'KRT.CSV');
  assert.equal(rows.length, 1);
});

test('a legacy .xls or .ods is refused with an instruction, not a stack trace', async () => {
  for (const name of ['old.xls', 'writer.ods']) {
    await assert.rejects(
      () => parseFile(csv(ROW), 'application/vnd.ms-excel', name),
      (err) => {
        assert.match(err.message, /save the file as \.xlsx/i, `${name} must say what to do`);
        return true;
      }
    );
  }
});

test('an unsupported format is refused by name', async () => {
  await assert.rejects(
    () => parseFile(Buffer.from('hello'), 'application/pdf', 'manuscript.pdf'),
    /Unsupported file format: pdf/
  );
});

test('a file that is not a spreadsheet at all is refused, not half-read', async () => {
  await assert.rejects(() => parseExcel(Buffer.from('%PDF-1.7 this is not a workbook')));
});
