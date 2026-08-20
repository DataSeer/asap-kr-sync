#!/usr/bin/env node
/**
 * Build reviewer-facing XLSX reports from a batch run's artifacts.
 *
 * Reads tmp/batch-check/<name>-artifacts.json (written by
 * batch-detection-check.js) and produces:
 *
 *   tmp/batch-check/reports/<name>.xlsx   one per document, every stage's data
 *   tmp/batch-check/reports/_SUMMARY.xlsx one global file: per-document metrics
 *                                         plus an Author-vs-Generated diff
 *
 * OFFLINE ON PURPOSE. It makes no LM calls and touches no database, so the
 * reports can be rebuilt, reformatted or re-scoped as often as you like without
 * paying for another run. That separation is the whole point of persisting
 * artifacts rather than only counts.
 *
 * Usage:
 *   node scripts/dev/build-krt-report-xlsx.js
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '../..');
const IN = path.join(ROOT, 'tmp/batch-check');
const OUT = path.join(IN, 'reports');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };

/** Verdict → row tint, so a reviewer can scan a sheet without reading it. */
const TINTS = {
  confirmed: 'FFE7F6E7',
  incomplete: 'FFFDF3D7',
  partial: 'FFE3EEFB',
  not_detected: 'FFFBE4E4',
  unsupported: 'FFFBE4E4',
  embellished: 'FFFDF3D7',
  verified: 'FFE7F6E7'
};

/**
 * Add a sheet with a styled header row, frozen panes and autofilter.
 * @param {ExcelJS.Workbook} wb
 * @param {string} title
 * @param {Array<{header: string, key: string, width: number}>} columns
 * @param {object[]} rows
 * @param {(row: object) => string|undefined} [tintBy] - returns a TINTS key
 */
function addSheet(wb, title, columns, rows, tintBy) {
  // Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 chars.
  const safe = title.replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  const ws = wb.addWorksheet(safe, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = HEADER_FONT;
  ws.getRow(1).fill = HEADER_FILL;
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };

  for (const r of rows) {
    const added = ws.addRow(r);
    const tint = tintBy && tintBy(r);
    if (tint && TINTS[tint]) {
      added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINTS[tint] } };
    }
    added.alignment = { vertical: 'top', wrapText: true };
  }
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return ws;
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const joinSources = (item) => (item.detectedBy || []).map((d) => d && d.source).filter(Boolean).join(', ');

/** Build one document's workbook. */
async function buildDocReport(a) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'asap-kr-sync batch report';

  const g = a.grounding || {};
  addSheet(wb, 'Overview', [
    { header: 'Field', key: 'k', width: 34 },
    { header: 'Value', key: 'v', width: 60 }
  ], [
    { k: 'Document', v: a.name },
    { k: 'Author KRT provided', v: a.hasAuthorKrt ? `yes (${a.krtFile})` : 'NO — discovery mode, review by hand' },
    { k: 'Markdown characters', v: a.markdownChars },
    { k: 'Author KRT rows', v: (a.authorKrt || []).length },
    { k: 'Detection candidates (merged)', v: (a.candidatePool || []).length },
    { k: 'Generated KRT rows', v: (a.generatedKrt || []).length },
    { k: 'Dropped by LM consolidation', v: (a.dropped || []).length },
    { k: 'Carried from author KRT (not re-detected)', v: (a.carriedFromAuthorKrt || []).length },
    { k: 'LM consolidation used', v: a.usedLM ? 'yes' : 'no (rule-based fallback)' },
    { k: '— grounding —', v: '' },
    { k: 'confirmed', v: g.confirmed ?? '' },
    { k: 'incomplete', v: g.incomplete ?? '' },
    { k: 'partial', v: g.partial ?? '' },
    { k: 'not detected', v: g.notDetected ?? '' }
  ]);

  // ── Generated KRT — the deliverable
  addSheet(wb, 'Generated KRT', [
    { header: 'RESOURCE TYPE', key: 'resourceType', width: 26 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 40 },
    { header: 'SOURCE', key: 'sourceUrl', width: 26 },
    { header: 'IDENTIFIER', key: 'identifier', width: 30 },
    { header: 'NEW/REUSE', key: 'newReuse', width: 11 },
    { header: 'ADDITIONAL INFORMATION', key: 'additionalInformation', width: 40 },
    { header: 'Detected by', key: 'sources', width: 24 },
    { header: 'Confidence', key: 'confidence', width: 11 },
    { header: 'Evidence quote (verified in manuscript)', key: 'quote', width: 60 },
    { header: 'Section', key: 'section', width: 26 },
    { header: 'From author KRT only', key: 'carried', width: 18 },
    { header: 'Why kept', key: 'reason', width: 34 }
  ], (a.generatedKrt || []).map((it) => ({
    resourceType: it.resourceType, resourceName: it.resourceName,
    sourceUrl: it.sourceUrl, identifier: it.identifier, newReuse: it.newReuse,
    additionalInformation: it.additionalInformation || '',
    sources: joinSources(it) || (it.carriedFromAuthorKrt ? 'author_krt' : ''),
    confidence: it.confidence,
    quote: it.evidence?.quote || '', section: it.evidence?.section || '',
    carried: it.carriedFromAuthorKrt ? 'yes' : '',
    reason: it.reason || ''
  })));

  // ── Author KRT + per-row verdict
  if (a.hasAuthorKrt) {
    const outcomeBy = new Map((a.outcomes || []).map((o) => [norm(o.resourceName), o]));
    addSheet(wb, 'Author KRT vs manuscript', [
      { header: 'RESOURCE TYPE', key: 'resourceType', width: 26 },
      { header: 'RESOURCE NAME', key: 'resourceName', width: 40 },
      { header: 'IDENTIFIER', key: 'identifier', width: 30 },
      { header: 'SOURCE', key: 'source', width: 24 },
      { header: 'Verdict', key: 'outcome', width: 14 },
      { header: 'Matched by', key: 'matchedBy', width: 14 },
      { header: 'Evidence quote', key: 'quote', width: 60 },
      { header: 'Manuscript adds (fills)', key: 'fills', width: 30 },
      { header: 'Conflicts', key: 'conflicts', width: 46 },
      { header: 'Explanation', key: 'reason', width: 60 }
    ], (a.authorKrt || []).map((r) => {
      const o = outcomeBy.get(norm(r.resourceName)) || {};
      return {
        resourceType: r.resourceType, resourceName: r.resourceName,
        identifier: r.identifier, source: r.source,
        outcome: o.outcome || '', matchedBy: o.matchedBy || '',
        quote: o.evidenceQuote || '',
        fills: Object.entries(o.foundValues || {}).map(([k, v]) => `${k}: ${v}`).join('; '),
        conflicts: (o.conflicts || []).map((c) => `${c.field}: KRT "${c.authorValue}" vs paper "${c.manuscriptValue}"`).join(' | '),
        reason: o.reason || ''
      };
    }), (r) => r.outcome);
  }

  // ── Every detection, per module, with its verification verdict
  const detRows = [];
  for (const [mod, items] of Object.entries(a.detections || {})) {
    for (const it of items) detRows.push({ module: mod, ...it });
  }
  addSheet(wb, 'Detections (all modules)', [
    { header: 'Module', key: 'module', width: 15 },
    { header: 'RESOURCE TYPE', key: 'resourceType', width: 24 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 38 },
    { header: 'IDENTIFIER', key: 'identifier', width: 28 },
    { header: 'SOURCE', key: 'source', width: 22 },
    { header: 'NEW/REUSE', key: 'newReuse', width: 11 },
    { header: 'Confidence', key: 'confidence', width: 11 },
    { header: 'Evidence status', key: 'status', width: 14 },
    { header: 'Located quote (verified)', key: 'quote', width: 58 },
    { header: 'Claimed quote (model, pre-check)', key: 'claimedQuote', width: 58 },
    { header: 'Section', key: 'section', width: 24 },
    { header: 'Mentions found', key: 'mentions', width: 14 }
  ], detRows, (r) => r.status);

  // ── What the LM consolidation removed, and why
  if ((a.dropped || []).length) {
    addSheet(wb, 'Dropped by consolidation', [
      { header: 'RESOURCE TYPE', key: 'resourceType', width: 24 },
      { header: 'RESOURCE NAME', key: 'resourceName', width: 40 },
      { header: 'IDENTIFIER', key: 'identifier', width: 28 },
      { header: 'Detected by', key: 'sources', width: 24 },
      { header: 'Reason dropped', key: 'reason', width: 60 }
    ], (a.dropped || []).map((d) => ({
      resourceType: d.resourceType, resourceName: d.resourceName,
      identifier: d.identifier, sources: (d.sources || []).join(', '), reason: d.reason
    })));
  }

  fs.mkdirSync(OUT, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT, `${a.name}.xlsx`));
}

/**
 * Diff the author KRT against the Generated KRT for one document.
 * Matching is intentionally simple and explainable — identifier equality or
 * normalized name equality — because a reviewer has to be able to check it.
 */
function diffDoc(a) {
  const rows = [];
  const gen = a.generatedKrt || [];
  const author = a.authorKrt || [];
  const genByName = new Map(gen.map((g) => [norm(g.resourceName), g]));
  const seen = new Set();

  for (const r of author) {
    const key = norm(r.resourceName);
    const g = genByName.get(key);
    if (g) seen.add(key);
    rows.push({
      document: a.name,
      status: g ? 'IN BOTH' : 'AUTHOR ONLY',
      resourceType: r.resourceType,
      resourceName: r.resourceName,
      authorIdentifier: r.identifier,
      generatedIdentifier: g ? g.identifier : '',
      authorSource: r.source,
      generatedSource: g ? g.sourceUrl : '',
      note: g ? '' : 'in the author KRT, absent from the Generated KRT'
    });
  }
  for (const g of gen) {
    const key = norm(g.resourceName);
    if (seen.has(key)) continue;
    if (author.some((r) => norm(r.resourceName) === key)) continue;
    rows.push({
      document: a.name,
      status: a.hasAuthorKrt ? 'GENERATED ONLY' : 'DISCOVERED (no author KRT)',
      resourceType: g.resourceType,
      resourceName: g.resourceName,
      authorIdentifier: '',
      generatedIdentifier: g.identifier,
      authorSource: '',
      generatedSource: g.sourceUrl,
      note: a.hasAuthorKrt ? 'proposed addition — check the manuscript' : 'discovery mode — review by hand'
    });
  }
  return rows;
}

(async () => {
  const files = fs.readdirSync(IN).filter((f) => f.endsWith('-artifacts.json')).sort();
  if (files.length === 0) {
    console.error(`No artifacts in ${path.relative(ROOT, IN)} — run batch-detection-check.js first.`);
    process.exit(1);
  }

  const summary = [];
  const diffRows = [];
  const conflictRows = [];

  for (const f of files) {
    const a = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf-8'));
    // Artifacts written before `name` existed would otherwise all collapse onto
    // a single "undefined.xlsx" — a silent overwrite rather than an error.
    if (!a.name) a.name = f.replace(/-artifacts\.json$/, '');
    await buildDocReport(a);

    const g = a.grounding || {};
    const rows = (a.authorKrt || []).length;
    const located = (g.confirmed || 0) + (g.incomplete || 0) + (g.partial || 0);
    summary.push({
      document: a.name,
      hasKrt: a.hasAuthorKrt ? 'yes' : 'NO',
      authorRows: rows,
      candidates: (a.candidatePool || []).length,
      generatedRows: (a.generatedKrt || []).length,
      confirmed: g.confirmed || 0,
      incomplete: g.incomplete || 0,
      partial: g.partial || 0,
      notDetected: g.notDetected || 0,
      locatedPct: rows ? Math.round((located / rows) * 100) : '',
      conflicts: (a.outcomes || []).reduce((n, o) => n + (o.conflicts || []).length, 0),
      droppedByLM: (a.dropped || []).length,
      carried: (a.carriedFromAuthorKrt || []).length,
      report: `${a.name}.xlsx`
    });

    diffRows.push(...diffDoc(a));
    for (const o of a.outcomes || []) {
      for (const c of o.conflicts || []) {
        conflictRows.push({
          document: a.name, resourceName: o.resourceName, field: c.field,
          authorValue: c.authorValue, manuscriptValue: c.manuscriptValue
        });
      }
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'asap-kr-sync batch report';

  addSheet(wb, 'Summary', [
    { header: 'Document', key: 'document', width: 30 },
    { header: 'Author KRT?', key: 'hasKrt', width: 12 },
    { header: 'Author rows', key: 'authorRows', width: 12 },
    { header: 'Candidates', key: 'candidates', width: 12 },
    { header: 'Generated rows', key: 'generatedRows', width: 15 },
    { header: 'confirmed', key: 'confirmed', width: 11 },
    { header: 'incomplete', key: 'incomplete', width: 11 },
    { header: 'partial', key: 'partial', width: 9 },
    { header: 'not detected', key: 'notDetected', width: 13 },
    { header: 'Located %', key: 'locatedPct', width: 11 },
    { header: 'Conflicts', key: 'conflicts', width: 10 },
    { header: 'Dropped by LM', key: 'droppedByLM', width: 14 },
    { header: 'Carried', key: 'carried', width: 9 },
    { header: 'Detail file', key: 'report', width: 34 }
  ], summary, (r) => (r.hasKrt === 'NO' ? 'partial' : undefined));

  addSheet(wb, 'Author vs Generated (diff)', [
    { header: 'Document', key: 'document', width: 28 },
    { header: 'Status', key: 'status', width: 26 },
    { header: 'RESOURCE TYPE', key: 'resourceType', width: 24 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 40 },
    { header: 'Author IDENTIFIER', key: 'authorIdentifier', width: 28 },
    { header: 'Generated IDENTIFIER', key: 'generatedIdentifier', width: 28 },
    { header: 'Author SOURCE', key: 'authorSource', width: 22 },
    { header: 'Generated SOURCE', key: 'generatedSource', width: 22 },
    { header: 'Note', key: 'note', width: 44 }
  ], diffRows, (r) => (r.status === 'IN BOTH' ? 'confirmed'
    : r.status === 'AUTHOR ONLY' ? 'not_detected' : 'partial'));

  addSheet(wb, 'Conflicts', [
    { header: 'Document', key: 'document', width: 28 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 40 },
    { header: 'Field', key: 'field', width: 14 },
    { header: 'Author KRT value', key: 'authorValue', width: 46 },
    { header: 'Manuscript value', key: 'manuscriptValue', width: 46 }
  ], conflictRows);

  fs.mkdirSync(OUT, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT, '_SUMMARY.xlsx'));

  console.log(`reports written to ${path.relative(ROOT, OUT)}/`);
  console.log(`  ${files.length} per-document workbooks + _SUMMARY.xlsx`);
  console.log(`  diff rows: ${diffRows.length}   conflicts: ${conflictRows.length}`);
})();
