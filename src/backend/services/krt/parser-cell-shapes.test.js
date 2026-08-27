/**
 * ExcelJS returns objects, and they nest. Reading one level is not enough.
 *
 * A cell is a bare string only when it carries no formatting and no link.
 * Otherwise it is an object, and the shapes COMPOSE:
 *
 *     { text, hyperlink }                        a link
 *     { text: { richText: [...] }, hyperlink }   a link whose label is styled
 *     { richText: [{ font, text }, ...] }        a styled cell
 *     { formula, result }                        a formula
 *
 * The parser read `.text` once. For the second shape that yields the inner
 * OBJECT, and `String()` of an object is the literal `[object Object]`.
 *
 * Found by Nicolas on TV1-000430-007: two identifier cells stored as
 * `[object Object]` in `krt_data`. Not a display bug — the corrupted string is
 * what every later step reads. It seeds the detection prompts, it is what
 * grounding searches the manuscript for, and it is what a curator is shown. A
 * row whose identifier is `[object Object]` cannot be found in any paper, so it
 * is reported as absent from a manuscript that may well contain it.
 *
 * These tests run against the real workbook rather than hand-built fixtures,
 * because the bug was in a shape nobody would have thought to invent — and a
 * fixture written from the same misunderstanding would have passed.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const parser = require('./parser.service');

const XLSX = path.join(__dirname, '../../../frontend/public/demo-files/TV1-000430-007-org-G-2.xlsx');
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const parse = () => parser.parseFile(fs.readFileSync(XLSX), MIME, 'TV1.xlsx');
const available = fs.existsSync(XLSX);

test('no cell stringifies to [object Object]', { skip: !available && 'demo file not present' }, async () => {
  const rows = await parse();

  const bad = [];
  for (const row of rows) {
    for (const [col, value] of Object.entries(row)) {
      if (String(value).includes('[object')) bad.push(`${col}: ${row['RESOURCE NAME']}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('a hyperlink whose label is rich text yields the label', { skip: !available && 'demo file not present' }, async () => {
  // The exact shape that broke: { text: { richText: [...] }, hyperlink }.
  const rows = await parse();
  const row = rows.find((r) => String(r['RESOURCE NAME'] || '').startsWith('RTGtools'));

  assert.ok(row, 'the RTGtools row is what carries the nested shape');
  assert.match(row.IDENTIFIER, /RRID unavailable/);
  assert.match(row.IDENTIFIER, /github\.com\/RealTimeGenomics/);
});

test('a link cell keeps its text, not its href', { skip: !available && 'demo file not present' }, async () => {
  // { text: 'protocols.io', hyperlink: 'http://protocols.io/' } — the label is
  // what the author wrote and what the manuscript would print.
  const rows = await parse();
  const linked = rows.filter((r) => String(r.SOURCE || '').includes('protocols.io'));

  assert.ok(linked.length > 0);
  for (const row of linked) assert.ok(!String(row.SOURCE).includes('[object'));
});

test('the identifiers survive well enough to be searched for', { skip: !available && 'demo file not present' }, async () => {
  // The point of the fix. `[object Object]` matches no manuscript, so grounding
  // reported these rows as absent from a paper that cites them.
  const rows = await parse();
  const row = rows.find((r) => String(r['RESOURCE NAME'] || '').startsWith('Detailed code'));

  assert.ok(row);
  assert.match(row.IDENTIFIER, /github\.com/);
  assert.match(row.IDENTIFIER, /10\.5281\/zenodo/);
});

test('every column header parses to something a column check can match', { skip: !available && 'demo file not present' }, async () => {
  // A header is a cell too. One reading `[object Object]` matches no known
  // column, and the whole sheet is then rejected as missing its columns —
  // a much louder failure than the one that was found, and the same cause.
  const rows = await parse();
  const check = parser.validateColumns(rows);

  assert.equal(check.valid, true, `missing: ${(check.missingColumns || []).join(', ')}`);
});
