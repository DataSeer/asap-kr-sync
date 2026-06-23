#!/usr/bin/env node
/**
 * Build an Excel workbook comparing datasets-detection results (v1 / v2 / v3)
 * against the DataSeer reports, for manual review.
 *
 * Each document tab shows, side by side, one block per generated version
 * (GENERATED KRT v1/v2/...), then KRT GENERATED FROM REPORT, then DATASETS DATA
 * FROM REPORT (verbatim "Datasets" tab). The generated KRT blocks and the
 * KRT-from-report block share the 5-column KRT shape (directly comparable); the
 * last block is the raw reference. Rows are anchored on the report datasets (in
 * report order); each generated row is aligned onto its matching report dataset
 * (by resource name / identifier). Generated rows that match no report dataset
 * are listed below a divider. No diff colouring — raw, for eyeball comparison.
 *
 * Only versions that actually have a results/<version>/ folder are shown, so the
 * workbook adapts to whatever the runner produced.
 *
 * Usage:
 *   node scripts/build-comparison-xlsx.js [resultsDir] [outFile] [reportsDir]
 * Defaults:
 *   resultsDir   tmp/datasets-detection/results
 *   outFile      <resultsDir>/comparison.xlsx
 *   reportsDir   src/frontend/public/demo-files
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadReportDatasets } = require('./lib/report-datasets');

const resultsDir = path.resolve(process.argv[2] || 'tmp/datasets-detection/results');
const outFile = path.resolve(process.argv[3] || path.join(resultsDir, 'comparison.xlsx'));
const reportsDir = path.resolve(process.argv[4] || 'src/frontend/public/demo-files');

const ALL_VERSIONS = ['v1', 'v2', 'v3'];
const VERSION_FILL = { v1: 'FFDCE6F1', v2: 'FFE2EFDA', v3: 'FFE4DFEC' };

const KRT_FIELDS = [
  { label: 'Resource Name', width: 40, get: (i) => i.resourceName },
  { label: 'Source', width: 22, get: (i) => i.source },
  { label: 'Identifier', width: 30, get: (i) => i.identifier },
  { label: 'New/Reuse', width: 11, get: (i) => i.newReuse },
  { label: 'Additional Info', width: 30, get: (i) => i.additionalInformation }
];

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

const FILL = { headerRow: 'FFF2F2F2', divider: 'FFEDEDED' };

// Versions present in the results dir, in canonical order.
const VERSIONS = ALL_VERSIONS.filter((v) => fs.existsSync(path.join(resultsDir, v)));

// Block layout: one KRT block per version, then the report KRT + raw blocks.
const BLOCKS = [
  ...VERSIONS.map((v) => ({ id: v, title: `GENERATED KRT ${v}`, fill: VERSION_FILL[v] || 'FFEEEEEE', source: v, fields: KRT_FIELDS })),
  { id: 'reportKrt', title: 'KRT GENERATED FROM REPORT', fill: 'FFFFF2CC', source: 'report', fields: KRT_FIELDS },
  { id: 'reportRaw', title: 'DATASETS DATA FROM REPORT', fill: 'FFFCE4D6', source: 'report', raw: true, fields: RAW_FIELDS }
];

function solid(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
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

function cellVal(item, field) {
  if (!item) return '';
  const v = field.get(item);
  return v == null ? '' : String(v);
}

function readResult(version, doc) {
  const file = path.join(resultsDir, version, `${doc}.json`);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

// Align every version onto the report datasets (report order); generated rows
// that match no report dataset go into `extra`.
function alignDoc(genByVersion, report) {
  const byKey = {};
  for (const v of VERSIONS) {
    byKey[v] = new Map();
    (genByVersion[v] || []).forEach((it) => { const k = keyOf(it); if (k && !byKey[v].has(k)) byKey[v].set(k, it); });
  }

  const seen = new Set();
  const anchored = report.map((rep) => {
    const k = keyOf(rep);
    seen.add(k);
    const row = { report: rep };
    for (const v of VERSIONS) row[v] = byKey[v].get(k) || null;
    return row;
  });

  const extra = [];
  const pushed = new Set();
  for (const v of VERSIONS) {
    for (const it of (genByVersion[v] || [])) {
      const k = keyOf(it);
      if (!k || seen.has(k) || pushed.has(k)) continue;
      pushed.add(k);
      const row = { report: null };
      for (const vv of VERSIONS) row[vv] = byKey[vv].get(k) || null;
      extra.push(row);
    }
  }

  const stats = { report: report.length };
  for (const v of VERSIONS) {
    stats[v] = (genByVersion[v] || []).length;
    stats[`${v}Matched`] = anchored.filter((r) => r[v]).length;
    stats[`${v}Extra`] = extra.filter((r) => r[v]).length;
  }
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

function buildDocSheet(wb, sheetName, genByVersion, report, seedByVersion = {}) {
  const { anchored, extra, stats } = alignDoc(genByVersion, report);
  const ws = wb.addWorksheet(sheetName);

  const cols = [];
  BLOCKS.forEach((blk, b) => {
    blk.fields.forEach((f) => cols.push({ width: f.width }));
    if (b < BLOCKS.length - 1) cols.push({ width: 3 });
  });
  ws.columns = cols;

  BLOCKS.forEach((blk, b) => {
    const start = blockStartCol(b);
    ws.mergeCells(1, start, 1, start + blk.fields.length - 1);
    const count = blk.id === 'reportKrt' || blk.id === 'reportRaw' ? stats.report : stats[blk.id];
    const cell = ws.getCell(1, start);
    let title = `${blk.title} — ${count}`;
    const seed = seedByVersion[blk.id];
    if (seed && seed.seedSource) {
      title += `  ·  seed: ${seed.seedSource}${seed.seedFile ? ` (${seed.seedFile})` : ''}`;
    }
    cell.value = title;
    cell.fill = solid(blk.fill);
    cell.font = { bold: true, size: 12 };
    cell.alignment = { horizontal: 'center' };
  });

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
  const columns = [
    { header: 'Document', key: 'doc', width: 30 },
    { header: 'Report', key: 'report', width: 9 }
  ];
  for (const v of VERSIONS) {
    columns.push({ header: v.toUpperCase(), key: v, width: 8 });
    columns.push({ header: `${v.toUpperCase()} matched`, key: `${v}Matched`, width: 12 });
    columns.push({ header: `${v.toUpperCase()} extra`, key: `${v}Extra`, width: 10 });
  }
  // Seed-provenance columns for versions that were seeded (which file fed them).
  const seededVersions = VERSIONS.filter((v) => perDoc.some((d) => d.seedByVersion[v]));
  for (const v of seededVersions) {
    columns.push({ header: `${v.toUpperCase()} seed`, key: `${v}Seed`, width: 34 });
  }
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = solid(FILL.headerRow);
  perDoc.forEach((d) => {
    const rowData = { doc: d.doc, ...d.stats };
    for (const v of seededVersions) {
      const s = d.seedByVersion[v];
      rowData[`${v}Seed`] = s ? `${s.seedSource}: ${s.seedFile}` : '';
    }
    ws.addRow(rowData);
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function main() {
  if (VERSIONS.length === 0) {
    console.error(`No version folders (${ALL_VERSIONS.join('/')}) under ${resultsDir} — run scripts/compare-datasets-prompts.js first.`);
    process.exit(1);
  }
  console.error(`Versions found: ${VERSIONS.join(', ')}`);

  const names = new Set();
  for (const v of VERSIONS) {
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
    const genByVersion = {};
    const seedByVersion = {};
    for (const v of VERSIONS) {
      const res = readResult(v, doc);
      genByVersion[v] = Array.isArray(res.krt) ? res.krt : [];
      if (res.seedSource) seedByVersion[v] = { seedSource: res.seedSource, seedFile: res.seedFile || '' };
    }
    const report = await loadReportDatasets(reportsDir, doc);
    const stats = buildDocSheet(wb, safeSheetName(doc, usedSheetNames), genByVersion, report, seedByVersion);
    perDoc.push({ doc, stats, seedByVersion });
    const versionNote = VERSIONS.map((v) => `${v}=${stats[v]}(${stats[`${v}Matched`]}✓/${stats[`${v}Extra`]}+)`).join(' ');
    console.error(`  ${doc}: report=${stats.report} ${versionNote}`);
  }

  fillSummarySheet(summaryWs, perDoc);
  await wb.xlsx.writeFile(outFile);
  console.error(`\nWrote ${outFile} (${docNames.length} document tabs + Summary)`);
}

main().catch((err) => {
  console.error('Failed to build comparison workbook:', err.message);
  process.exit(1);
});
