#!/usr/bin/env node
/**
 * Build an Excel workbook comparing the v1 vs v2 datasets-detection results
 * produced by scripts/compare-datasets-prompts.js.
 *
 * Layout:
 *   - "Summary" tab: one row per document with v1/v2 counts and add/remove/
 *     change tallies.
 *   - One tab per document: the two KRTs side by side, aligned by resource
 *     name so matching resources sit on the same row. Colour coding:
 *       red    = only in v1 (removed in v2)
 *       green  = only in v2 (added in v2)
 *       yellow = present in both but a field changed
 *
 * Usage:
 *   node scripts/build-comparison-xlsx.js [resultsDir] [outFile]
 * Defaults:
 *   resultsDir  tmp/datasets-detection/results   (must contain v1/ and v2/)
 *   outFile     <resultsDir>/comparison.xlsx
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const resultsDir = path.resolve(process.argv[2] || 'tmp/datasets-detection/results');
const outFile = path.resolve(process.argv[3] || path.join(resultsDir, 'comparison.xlsx'));

const FIELDS = [
  { key: 'resourceName', label: 'Resource Name', width: 42 },
  { key: 'source', label: 'Source', width: 34 },
  { key: 'identifier', label: 'Identifier', width: 28 },
  { key: 'newReuse', label: 'New/Reuse', width: 11 },
  { key: 'additionalInformation', label: 'Additional Info', width: 34 }
];

const FILL = {
  removed: 'FFF8D7DA', // light red  — only in v1
  added: 'FFD4EDDA', // light green — only in v2
  changed: 'FFFFF3CD', // light yellow — field differs
  v1Header: 'FFDCE6F1', // light blue
  v2Header: 'FFE2EFDA', // light green
  headerRow: 'FFF2F2F2'
};

function solid(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function readKrt(version, name) {
  const file = path.join(resultsDir, version, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data.krt) ? data.krt : [];
  } catch {
    return null;
  }
}

function keyOf(item) {
  const name = String(item.resourceName || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (name) return name;
  return String(item.identifier || '').toLowerCase().trim();
}

function val(item, key) {
  if (!item) return '';
  const v = item[key];
  return v == null ? '' : String(v);
}

// Build the aligned rows for one document. Returns { rows, stats }.
function alignDoc(v1Items, v2Items) {
  const v1ByKey = new Map();
  const v2ByKey = new Map();
  (v1Items || []).forEach((it) => v1ByKey.set(keyOf(it), it));
  (v2Items || []).forEach((it) => v2ByKey.set(keyOf(it), it));

  const keys = [...new Set([...v1ByKey.keys(), ...v2ByKey.keys()])].filter(Boolean).sort();
  const stats = { v1: (v1Items || []).length, v2: (v2Items || []).length, added: 0, removed: 0, changed: 0, same: 0 };

  const rows = keys.map((key) => {
    const left = v1ByKey.get(key) || null;
    const right = v2ByKey.get(key) || null;
    let status;
    const changedFields = new Set();
    if (!left) { status = 'added'; stats.added++; }
    else if (!right) { status = 'removed'; stats.removed++; }
    else {
      FIELDS.forEach((f) => { if (val(left, f.key) !== val(right, f.key)) changedFields.add(f.key); });
      if (changedFields.size > 0) { status = 'changed'; stats.changed++; }
      else { status = 'same'; stats.same++; }
    }
    return { left, right, status, changedFields };
  });

  return { rows, stats };
}

// Excel sheet names: <=31 chars, no : \ / ? * [ ]. Dedupe collisions.
function safeSheetName(name, used) {
  let base = name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = `~${i++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function buildDocSheet(wb, docName, sheetName, v1Items, v2Items) {
  const { rows, stats } = alignDoc(v1Items, v2Items);
  const ws = wb.addWorksheet(sheetName);

  const nLeft = FIELDS.length;          // cols 1..5
  const spacerCol = nLeft + 1;          // col 6
  const rightStart = nLeft + 2;         // col 7

  // Column widths
  const cols = [];
  FIELDS.forEach((f) => cols.push({ width: f.width }));
  cols.push({ width: 3 }); // spacer
  FIELDS.forEach((f) => cols.push({ width: f.width }));
  ws.columns = cols;

  // Title row (1): merged V1 / V2 banners with counts
  ws.mergeCells(1, 1, 1, nLeft);
  ws.mergeCells(1, rightStart, 1, rightStart + nLeft - 1);
  const v1Title = ws.getCell(1, 1);
  const v2Title = ws.getCell(1, rightStart);
  v1Title.value = `V1 — ${(v1Items || []).length} resources`;
  v2Title.value = `V2 — ${(v2Items || []).length} resources`;
  v1Title.fill = solid(FILL.v1Header);
  v2Title.fill = solid(FILL.v2Header);
  [v1Title, v2Title].forEach((c) => { c.font = { bold: true, size: 12 }; c.alignment = { horizontal: 'center' }; });

  // Header row (2)
  FIELDS.forEach((f, i) => {
    const l = ws.getCell(2, 1 + i);
    const r = ws.getCell(2, rightStart + i);
    l.value = f.label; r.value = f.label;
    [l, r].forEach((c) => { c.font = { bold: true }; c.fill = solid(FILL.headerRow); c.alignment = { wrapText: true, vertical: 'top' }; });
  });

  // Data rows (3+)
  rows.forEach((row, idx) => {
    const r = idx + 3;
    FIELDS.forEach((f, i) => {
      const lc = ws.getCell(r, 1 + i);
      const rc = ws.getCell(r, rightStart + i);
      lc.value = val(row.left, f.key);
      rc.value = val(row.right, f.key);
      lc.alignment = { wrapText: true, vertical: 'top' };
      rc.alignment = { wrapText: true, vertical: 'top' };

      if (row.status === 'removed') {
        lc.fill = solid(FILL.removed);
      } else if (row.status === 'added') {
        rc.fill = solid(FILL.added);
      } else if (row.status === 'changed' && row.changedFields.has(f.key)) {
        lc.fill = solid(FILL.changed);
        rc.fill = solid(FILL.changed);
      }
    });
  });

  // Freeze the title + header rows for scrolling.
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 2 }];
  ws.getColumn(spacerCol).border = undefined;
  return stats;
}

function fillSummarySheet(ws, perDoc) {
  ws.columns = [
    { header: 'Document', key: 'doc', width: 30 },
    { header: 'V1 count', key: 'v1', width: 10 },
    { header: 'V2 count', key: 'v2', width: 10 },
    { header: 'Added (v2 only)', key: 'added', width: 15 },
    { header: 'Removed (v1 only)', key: 'removed', width: 17 },
    { header: 'Changed', key: 'changed', width: 10 },
    { header: 'Unchanged', key: 'same', width: 11 }
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = solid(FILL.headerRow);
  perDoc.forEach((d) => ws.addRow({ doc: d.doc, ...d.stats }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Highlight rows that have any difference.
  ws.eachRow((rowObj, rowNumber) => {
    if (rowNumber === 1) return;
    const added = rowObj.getCell('added').value || 0;
    const removed = rowObj.getCell('removed').value || 0;
    const changed = rowObj.getCell('changed').value || 0;
    if (added + removed + changed > 0) {
      ['added', 'removed', 'changed'].forEach((k) => {
        if (rowObj.getCell(k).value) rowObj.getCell(k).fill = solid(FILL.changed);
      });
    }
  });
}

async function main() {
  for (const v of ['v1', 'v2']) {
    if (!fs.existsSync(path.join(resultsDir, v))) {
      console.error(`Missing ${path.join(resultsDir, v)} — run scripts/compare-datasets-prompts.js first.`);
      process.exit(1);
    }
  }

  const names = new Set();
  for (const v of ['v1', 'v2']) {
    fs.readdirSync(path.join(resultsDir, v))
      .filter((f) => f.endsWith('.json'))
      .forEach((f) => names.add(path.basename(f, '.json')));
  }
  const docNames = [...names].sort();
  if (docNames.length === 0) {
    console.error('No result JSON files found — nothing to compare.');
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  const usedSheetNames = new Set(['Summary']);
  const perDoc = [];

  // Create Summary first so it is the leftmost tab; populate it at the end.
  const summaryWs = wb.addWorksheet('Summary');

  for (const doc of docNames) {
    const v1Items = readKrt('v1', doc);
    const v2Items = readKrt('v2', doc);
    const sheetName = safeSheetName(doc, usedSheetNames);
    const stats = buildDocSheet(wb, doc, sheetName, v1Items, v2Items);
    perDoc.push({ doc, stats });
    console.error(`  ${doc}: v1=${stats.v1} v2=${stats.v2} (+${stats.added} -${stats.removed} ~${stats.changed})`);
  }

  fillSummarySheet(summaryWs, perDoc);

  await wb.xlsx.writeFile(outFile);
  console.error(`\nWrote ${outFile} (${docNames.length} document tabs + Summary)`);
}

main().catch((err) => {
  console.error('Failed to build comparison workbook:', err.message);
  process.exit(1);
});
