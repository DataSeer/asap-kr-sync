#!/usr/bin/env node
/**
 * Build an Excel workbook comparing datasets-detection results (v1 vs v2)
 * against the DataSeer reports, for manual review.
 *
 * Each document tab shows four blocks side by side:
 *   GENERATED KRT v1 | GENERATED KRT v2 | KRT GENERATED FROM REPORT | DATASETS DATA FROM REPORT
 *
 * The first three are the same 5-column KRT shape (directly comparable). The
 * fourth is the verbatim "Datasets" tab data from the report. Rows are anchored
 * on the report datasets (in report order); each generated v1/v2 row is aligned
 * onto its matching report dataset (by resource name / identifier). Generated
 * rows that match no report dataset are listed below a divider. No diff
 * colouring — the layout is raw so a curator compares by eye.
 *
 * The report data comes from each manuscript's DataSeer report
 * (<id>-DS1.xlsx, fallback <id>.xlsx), "Datasets" tab. The KRT-from-report view
 * maps:  Dataset Name -> resource name;  Re-Use -> new/reuse (true=reuse);
 *        URL + DOI/Identifier -> identifier (the "warrant" columns merged);
 *        Notes -> additional info.
 *
 * Usage:
 *   node scripts/build-comparison-xlsx.js [resultsDir] [outFile] [reportsDir]
 * Defaults:
 *   resultsDir   tmp/datasets-detection/results        (with v1/ and v2/)
 *   outFile      <resultsDir>/comparison.xlsx
 *   reportsDir   src/frontend/public/demo-files         (holds <id>-DS1.xlsx)
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const resultsDir = path.resolve(process.argv[2] || 'tmp/datasets-detection/results');
const outFile = path.resolve(process.argv[3] || path.join(resultsDir, 'comparison.xlsx'));
const reportsDir = path.resolve(process.argv[4] || 'src/frontend/public/demo-files');

// 5-column KRT shape used by the v1/v2/report-KRT blocks.
const KRT_FIELDS = [
  { label: 'Resource Name', width: 40, get: (i) => i.resourceName },
  { label: 'Source', width: 22, get: (i) => i.source },
  { label: 'Identifier', width: 30, get: (i) => i.identifier },
  { label: 'New/Reuse', width: 11, get: (i) => i.newReuse },
  { label: 'Additional Info', width: 30, get: (i) => i.additionalInformation }
];

// Verbatim "Datasets" tab columns for the raw report block.
const RAW_FIELDS = [
  { label: 'Dataset Name', width: 36, get: (r) => r.datasetName },
  { label: 'Re-Use', width: 8, get: (r) => r.reUse },
  { label: 'QC', width: 6, get: (r) => r.qc },
  { label: 'Rep', width: 6, get: (r) => r.rep },
  { label: 'Issue', width: 6, get: (r) => r.issue },
  { label: 'Sentence from article text', width: 44, get: (r) => r.sentence },
  { label: 'URL', width: 30, get: (r) => r.url },
  { label: 'DOI/Identifier', width: 20, get: (r) => r.doi },
  { label: 'Notes', width: 24, get: (r) => r.notes },
  { label: 'Associated Figure', width: 16, get: (r) => r.associatedFigure },
  { label: 'ReadMe', width: 8, get: (r) => r.readme },
  { label: 'Datatype', width: 24, get: (r) => r.datatype }
];

// source: which aligned item feeds the block. raw: read item.raw instead.
const BLOCKS = [
  { id: 'v1', title: 'GENERATED KRT v1', fill: 'FFDCE6F1', source: 'v1', fields: KRT_FIELDS },
  { id: 'v2', title: 'GENERATED KRT v2', fill: 'FFE2EFDA', source: 'v2', fields: KRT_FIELDS },
  { id: 'reportKrt', title: 'KRT GENERATED FROM REPORT', fill: 'FFFFF2CC', source: 'report', fields: KRT_FIELDS },
  { id: 'reportRaw', title: 'DATASETS DATA FROM REPORT', fill: 'FFFCE4D6', source: 'report', raw: true, fields: RAW_FIELDS }
];

const FILL = { headerRow: 'FFF2F2F2', divider: 'FFEDEDED' };

function solid(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    return String(
      v.text || v.result || v.hyperlink ||
      (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : '') || ''
    );
  }
  return String(v);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function keyOf(item) {
  if (!item) return '';
  const name = norm(item.resourceName);
  if (name) return name;
  return norm(item.identifier);
}

function findReportFile(doc) {
  for (const name of [`${doc}-DS1.xlsx`, `${doc}.xlsx`]) {
    const p = path.join(reportsDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Extract dataset rows from a report's "Datasets" tab. The tab has repeated
// action-required sections, each re-printing the column header; we re-read the
// column map at each header and collect the numbered data rows under it.
async function loadReportDatasets(doc) {
  const file = findReportFile(doc);
  if (!file) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Datasets');
  if (!ws) return [];

  const out = [];
  const seen = new Set();
  let map = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    const get = (c) => (c > 0 ? cellText(ws.getCell(r, c).value).trim() : '');
    const labels = [];
    for (let c = 1; c <= ws.columnCount; c++) labels[c] = norm(ws.getCell(r, c).value && cellText(ws.getCell(r, c).value));

    if (labels.some((v) => v === 'dataset name')) {
      const find = (pred) => labels.findIndex(pred);
      map = {
        idx: find((v) => v === '#'),
        name: find((v) => v === 'dataset name'),
        reuse: find((v) => v === 're-use' || v === 'reuse'),
        qc: find((v) => v === 'qc'),
        rep: find((v) => v === 'rep'),
        issue: find((v) => v === 'issue'),
        sentence: find((v) => /sentence/.test(v)),
        url: find((v) => v === 'url'),
        doi: find((v) => /doi|identifier/.test(v)),
        notes: find((v) => v === 'notes'),
        assocFig: find((v) => /associated figure/.test(v)),
        readme: find((v) => v === 'readme'),
        datatype: find((v) => v === 'datatype')
      };
      continue;
    }
    if (!map) continue;

    const idxVal = get(map.idx);
    const name = get(map.name);
    if (!/^\d+$/.test(idxVal) || !name) continue;
    const k = norm(name);
    if (seen.has(k)) continue;
    seen.add(k);

    const url = get(map.url);
    const doi = get(map.doi);
    const notes = get(map.notes);
    const reUse = get(map.reuse);
    out.push({
      resourceType: 'Dataset',
      resourceName: name,
      source: '',
      identifier: [url, doi].filter(Boolean).join('; '), // warrant columns merged
      newReuse: /true|reuse|yes/i.test(reUse) ? 'reuse' : 'new',
      additionalInformation: notes,
      raw: {
        datasetName: name,
        reUse,
        qc: get(map.qc),
        rep: get(map.rep),
        issue: get(map.issue),
        sentence: get(map.sentence),
        url,
        doi,
        notes,
        associatedFigure: get(map.assocFig),
        readme: get(map.readme),
        datatype: get(map.datatype)
      }
    });
  }
  return out;
}

function readGenerated(version, doc) {
  const file = path.join(resultsDir, version, `${doc}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data.krt) ? data.krt : [];
  } catch {
    return [];
  }
}

// Align v1/v2 onto the report datasets (report order); generated rows that
// match no report dataset go into `extra`.
function alignDoc(v1, v2, report) {
  const v1ByKey = new Map();
  const v2ByKey = new Map();
  v1.forEach((it) => { const k = keyOf(it); if (k && !v1ByKey.has(k)) v1ByKey.set(k, it); });
  v2.forEach((it) => { const k = keyOf(it); if (k && !v2ByKey.has(k)) v2ByKey.set(k, it); });

  const seen = new Set();
  const anchored = report.map((rep) => {
    const k = keyOf(rep);
    seen.add(k);
    return { v1: v1ByKey.get(k) || null, v2: v2ByKey.get(k) || null, report: rep };
  });

  const extra = [];
  const pushed = new Set();
  const addExtra = (list) => {
    for (const it of list) {
      const k = keyOf(it);
      if (!k || seen.has(k) || pushed.has(k)) continue;
      pushed.add(k);
      extra.push({ v1: v1ByKey.get(k) || null, v2: v2ByKey.get(k) || null, report: null });
    }
  };
  addExtra(v1);
  addExtra(v2);

  const stats = {
    report: report.length,
    v1: v1.length,
    v2: v2.length,
    v1Matched: anchored.filter((r) => r.v1).length,
    v2Matched: anchored.filter((r) => r.v2).length,
    v1Extra: extra.filter((r) => r.v1).length,
    v2Extra: extra.filter((r) => r.v2).length
  };
  return { anchored, extra, stats };
}

function safeSheetName(name, used) {
  const base = name.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = `~${i++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

// Blocks have different widths; compute each block's starting column.
function blockStartCol(blockIdx) {
  let col = 1;
  for (let i = 0; i < blockIdx; i++) col += BLOCKS[i].fields.length + 1; // +1 spacer
  return col;
}

function itemForBlock(rowData, blk) {
  const item = rowData[blk.source];
  if (!item) return null;
  return blk.raw ? (item.raw || null) : item;
}

function writeRow(ws, rowNum, rowData) {
  BLOCKS.forEach((blk, b) => {
    const start = blockStartCol(b);
    const item = itemForBlock(rowData, blk);
    blk.fields.forEach((field, c) => {
      const cell = ws.getCell(rowNum, start + c);
      cell.value = item ? (field.get(item) ?? '') : '';
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
  });
}

function buildDocSheet(wb, sheetName, v1, v2, report) {
  const { anchored, extra, stats } = alignDoc(v1, v2, report);
  const ws = wb.addWorksheet(sheetName);

  // Column widths across all blocks + spacers
  const cols = [];
  BLOCKS.forEach((blk, b) => {
    blk.fields.forEach((f) => cols.push({ width: f.width }));
    if (b < BLOCKS.length - 1) cols.push({ width: 3 });
  });
  ws.columns = cols;

  // Row 1: banners with counts
  BLOCKS.forEach((blk, b) => {
    const start = blockStartCol(b);
    ws.mergeCells(1, start, 1, start + blk.fields.length - 1);
    const counts = { v1: stats.v1, v2: stats.v2, reportKrt: stats.report, reportRaw: stats.report }[blk.id];
    const cell = ws.getCell(1, start);
    cell.value = `${blk.title} — ${counts}`;
    cell.fill = solid(blk.fill);
    cell.font = { bold: true, size: 12 };
    cell.alignment = { horizontal: 'center' };
  });

  // Row 2: per-block column headers
  BLOCKS.forEach((blk, b) => {
    const start = blockStartCol(b);
    blk.fields.forEach((field, c) => {
      const cell = ws.getCell(2, start + c);
      cell.value = field.label;
      cell.font = { bold: true };
      cell.fill = solid(FILL.headerRow);
      cell.alignment = { wrapText: true, vertical: 'top' };
    });
  });

  let r = 3;
  anchored.forEach((row) => { writeRow(ws, r, row); r += 1; });

  if (extra.length > 0) {
    const lastCol = blockStartCol(BLOCKS.length - 1) + BLOCKS[BLOCKS.length - 1].fields.length - 1;
    ws.mergeCells(r, 1, r, lastCol);
    const dcell = ws.getCell(r, 1);
    dcell.value = '— Generated, not in Reports —';
    dcell.fill = solid(FILL.divider);
    dcell.font = { italic: true, bold: true };
    dcell.alignment = { horizontal: 'center' };
    r += 1;
    extra.forEach((row) => { writeRow(ws, r, row); r += 1; });
  }

  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return stats;
}

function fillSummarySheet(ws, perDoc) {
  ws.columns = [
    { header: 'Document', key: 'doc', width: 30 },
    { header: 'Report', key: 'report', width: 9 },
    { header: 'V1', key: 'v1', width: 8 },
    { header: 'V2', key: 'v2', width: 8 },
    { header: 'V1 matched', key: 'v1Matched', width: 12 },
    { header: 'V2 matched', key: 'v2Matched', width: 12 },
    { header: 'V1 extra', key: 'v1Extra', width: 10 },
    { header: 'V2 extra', key: 'v2Extra', width: 10 }
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = solid(FILL.headerRow);
  perDoc.forEach((d) => ws.addRow({ doc: d.doc, ...d.stats }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
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
  const summaryWs = wb.addWorksheet('Summary');
  const perDoc = [];

  for (const doc of docNames) {
    const v1 = readGenerated('v1', doc);
    const v2 = readGenerated('v2', doc);
    const report = await loadReportDatasets(doc);
    const stats = buildDocSheet(wb, safeSheetName(doc, usedSheetNames), v1, v2, report);
    perDoc.push({ doc, stats });
    console.error(`  ${doc}: report=${stats.report} v1=${stats.v1}(${stats.v1Matched}✓/${stats.v1Extra}+) v2=${stats.v2}(${stats.v2Matched}✓/${stats.v2Extra}+)`);
  }

  fillSummarySheet(summaryWs, perDoc);
  await wb.xlsx.writeFile(outFile);
  console.error(`\nWrote ${outFile} (${docNames.length} document tabs + Summary)`);
}

main().catch((err) => {
  console.error('Failed to build comparison workbook:', err.message);
  process.exit(1);
});
