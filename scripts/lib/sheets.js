/**
 * Reading and writing spreadsheets, on exceljs.
 *
 * The scripts here used `xlsx` (SheetJS). It carries two unfixed high-severity
 * advisories — prototype pollution and a ReDoS — and there is no fixed version
 * on npm at all: SheetJS moved distribution off the registry, so `npm audit
 * fix` can never resolve it. The runtime already writes spreadsheets with
 * `exceljs`, so the app was carrying two spreadsheet libraries and shipping the
 * unfixable one in the image for the sake of three scripts.
 *
 * These helpers cover exactly what those scripts used, in the terms they used
 * it, so the ports read like the originals instead of like exceljs. The one
 * behavioural difference worth knowing: exceljs is ASYNC on file I/O.
 */

const ExcelJS = require('exceljs');

/**
 * A worksheet as an array of row objects, keyed by the header row.
 *
 * The `xlsx` equivalent of `sheet_to_json(sheet, { defval })`. Blank cells
 * become `defval` rather than being absent, because a caller that reads
 * `row['Identifier']` should not have to care whether the cell was empty or
 * missing — that distinction is a spreadsheet detail, not a data one.
 *
 * @param {ExcelJS.Worksheet} sheet
 * @param {{defval?: any}} [opts]
 * @returns {object[]}
 */
function sheetToObjects(sheet, { defval = '' } = {}) {
  if (!sheet) return [];
  const headers = [];
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cellText(cell);
  });

  const out = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj = {};
    let anyValue = false;
    headers.forEach((name, i) => {
      if (!name) return;
      const text = cellText(row.getCell(i + 1));
      if (text !== '') anyValue = true;
      obj[name] = text === '' ? defval : text;
    });
    // A wholly blank row is padding, not a record. `sheet_to_json` skipped
    // these too; keeping them turns "12 protocols" into "1200 protocols".
    if (anyValue) out.push(obj);
  }
  return out;
}

/**
 * A worksheet as an array of arrays — the `{ header: 1 }` form.
 *
 * Used where a script reads a report whose header row is not at the top, or
 * whose columns are positional.
 *
 * @param {ExcelJS.Worksheet} sheet
 * @param {{defval?: any}} [opts]
 * @returns {any[][]}
 */
function sheetToRows(sheet, { defval = '' } = {}) {
  if (!sheet) return [];
  const out = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const values = [];
    const width = Math.max(row.cellCount, 1);
    for (let c = 1; c <= width; c++) {
      const text = cellText(row.getCell(c));
      values.push(text === '' ? defval : text);
    }
    out.push(values);
  }
  return out;
}

/**
 * A cell's value as the text a reader would see.
 *
 * exceljs returns rich objects for formulas, hyperlinks and rich text, and a
 * bare `cell.value` on any of those yields `[object Object]` in the output —
 * which is how a column of DOIs turns into a column of nothing.
 *
 * @param {ExcelJS.Cell} cell
 * @returns {string}
 */
function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (typeof v.text === 'string') return v.text;            // hyperlink
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return String(v.result ?? '');          // formula
    if ('error' in v) return '';
    return String(v);
  }
  return String(v);
}

/**
 * Append rows of objects as a sheet.
 *
 * The `xlsx` equivalent of `json_to_sheet` + `book_append_sheet`. `header`
 * fixes the column order; without it the union of every row's keys is used, in
 * first-seen order — objects have no inherent column order, and letting it fall
 * out of key iteration is how an exported file silently reorders itself between
 * runs.
 *
 * @param {ExcelJS.Workbook} workbook
 * @param {string} name
 * @param {object[]} rows
 * @param {{header?: string[], widths?: number[], wrapColumns?: string[]}} [opts]
 * @returns {ExcelJS.Worksheet}
 */
function addObjectSheet(workbook, name, rows, { header, widths, wrapColumns = [] } = {}) {
  const columns = header || unionOfKeys(rows);
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((key, i) => ({
    header: key,
    key,
    width: widths?.[i] ?? Math.min(Math.max(key.length + 2, 12), 60)
  }));
  for (const row of rows) {
    sheet.addRow(columns.reduce((acc, key) => {
      acc[key] = row[key] ?? '';
      return acc;
    }, {}));
  }
  sheet.getRow(1).font = { bold: true };

  for (const columnName of wrapColumns) {
    const idx = columns.indexOf(columnName);
    if (idx < 0) continue;
    sheet.getColumn(idx + 1).alignment = { wrapText: true, vertical: 'top' };
  }
  return sheet;
}

/** Every key any row carries, in first-seen order. */
function unionOfKeys(rows) {
  const keys = [];
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Read a workbook from disk. `.csv` is read as a single sheet, matching the
 * rest of the scripts and the app's own parser.
 *
 * @param {string} file
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function readWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(file)) await workbook.csv.readFile(file);
  else await workbook.xlsx.readFile(file);
  return workbook;
}

/** A fresh workbook. */
const newWorkbook = () => new ExcelJS.Workbook();

/**
 * @param {ExcelJS.Workbook} workbook
 * @param {string} file
 */
async function writeWorkbook(workbook, file) {
  await workbook.xlsx.writeFile(file);
}

module.exports = {
  readWorkbook,
  newWorkbook,
  writeWorkbook,
  sheetToObjects,
  sheetToRows,
  addObjectSheet,
  cellText
};
