#!/usr/bin/env node
/**
 * AI Suggestions quality evaluation harness.
 *
 * For each document in tmp/suggestions-quality/documents/ that has a PDF + an
 * author KRT, it runs the SAME in-process pipeline the app uses (detectors →
 * mergeDetections → LM consolidation → LM comparison) twice:
 *
 *   Pass A (original KRT):  author KRT = the document's KRT file.
 *     Expectation: the Generated KRT is already covered by the author KRT, so
 *     there are few "add" suggestions (catches over-detection / hallucination).
 *
 *   Pass B (modified KRT):  some KRT lines are removed, then re-run.
 *     Expectation: removed lines that SHOULD be detectable reappear in the
 *     Generated KRT and as "add" suggestions (measures detection RECALL).
 *     By default only "clearly-detectable" lines are removed (per summary.csv:
 *     Shared in Text or Supplemental, not Optional). With --random, a random
 *     subset of any line is removed instead.
 *
 * Writes one xlsx per document + a global _summary.xlsx with recall metrics
 * broken down by Object Type and the summary's "Shared in …" flags.
 *
 * Requires the same external services the app uses, configured in .env:
 *   Docling/MarkItDown (markdown), Softcite (software), and Gemini for
 *   datasets/protocols/materials + KRT_GENERATION_* + KRT_COMPARISON_*.
 *   A module with no key simply yields nothing (same as the app).
 *
 * Usage:
 *   node scripts/eval-suggestions-quality.js [options]
 * Options:
 *   --dir DIR         input root (default: tmp/suggestions-quality)
 *   --out DIR         output dir (default: <dir>/results)
 *   --doc ID          only this document id (repeatable via comma)
 *   --modules a,b     only run these detection modules
 *   --skip-modules x  run all detection modules except these
 *                     (modules: software, datasets, protocols, materials, identifier)
 *   --concurrency N   process N documents in parallel (default 2)
 *   --random          pass B removes a random subset of ANY line (not just detectable)
 *   --remove-frac F   fraction to remove per resource type in pass B (default 0.5, min 1 per type)
 *   --seed N          RNG seed for deterministic removal (default 42)
 *   --skip-modified   only run pass A
 *   --markdown-only   only convert + cache each PDF's markdown (pre-warm), then exit
 *   --refresh-markdown re-convert markdown even if a cached .md exists
 *   --plan            offline: discover + parse + show the removal plan, NO pipeline/API calls
 *   --no-trace        skip the per-document traces/ folder (raw LM responses + stage JSON)
 *   --help
 *
 * Markdown is cached on disk at <dir>/markdown/<id>.md after the first run, so
 * later runs (different module flags / removal seeds) reuse it and skip Docling.
 *
 * Per-document trace (on by default) is written to <out>/traces/<id>/ — inputs,
 * each detection module's items, merged candidates, the LM consolidation and the
 * LM comparison decisions, plus every stage's raw LM response as a .txt file.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const Papa = require('papaparse');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ── Pipeline imports (same code the app runs) ───────────────────────────────
const { convertToMarkdown } = require('../src/backend/services/pdf/pdf-markdown-client.service');
const softwareService = require('../src/backend/services/software/software.service');
const datasetsService = require('../src/backend/services/datasets/datasets.service');
const protocolsService = require('../src/backend/services/protocols/protocols.service');
const materialsService = require('../src/backend/services/materials/materials.service');
const identifierService = require('../src/backend/services/identifier-detection/identifier-detection.service');
const knownIdentifierIndex = require('../src/backend/services/identifier-detection/known-identifier-index.service');
const { createCsvProvider } = require('../src/backend/services/enrichment-list-providers');
const { dedupeKrtItems } = require('../src/backend/services/pdf-analysis/dedupe-krt-items.service');
const { mergeDetections } = require('../src/backend/services/pdf-analysis/merge-detections.service');
const { consolidateWithLM } = require('../src/backend/services/pdf-analysis/krt-generation.service');
const { compareKrts } = require('../src/backend/services/suggestion/kr-comparison.service');
const { buildAuthorSeeds } = require('../src/backend/services/krt/author-krt-seeds.service');
const { normalizeName, identifiersMatch } = require('../src/backend/services/pdf-analysis/identifier-normalize.service');

const IDENTIFIERS_DIR = path.join(__dirname, '../tmp/identifiers');

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf-8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] || '');
  process.exit(0);
}
const getArg = (name, def) => { const i = argv.indexOf(name); return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : def; };
const has = (name) => argv.includes(name);

const ROOT = path.resolve(getArg('--dir', path.join(__dirname, '../tmp/suggestions-quality')));
const DOC_DIR = path.join(ROOT, 'documents');
const OUT_DIR = path.resolve(getArg('--out', path.join(ROOT, 'results')));
const ONLY_DOCS = (getArg('--doc', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const RANDOM_MODE = has('--random');
const REMOVE_FRAC = Math.max(0, Math.min(1, parseFloat(getArg('--remove-frac', '0.5')) || 0.5));
const SKIP_MODIFIED = has('--skip-modified');
const PLAN_ONLY = has('--plan');
const MARKDOWN_ONLY = has('--markdown-only');
const REFRESH_MARKDOWN = has('--refresh-markdown');
const MD_DIR = path.join(ROOT, 'markdown');
const CONCURRENCY = Math.max(1, parseInt(getArg('--concurrency', '2'), 10) || 2);
// Per-document trace (raw LM responses + every pipeline stage as JSON). On by
// default so runs are auditable; disable with --no-trace for lighter output.
const TRACE = !has('--no-trace');

// Detection-module include/skip (instead of toggling .env). Modules not enabled
// here are simply not run (their items are empty), regardless of .env config.
const ALL_MODULES = ['software', 'datasets', 'protocols', 'materials', 'identifier'];
const onlyModules = (getArg('--modules', '') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const skipModules = (getArg('--skip-modules', '') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const moduleEnabled = (m) => (onlyModules.length ? onlyModules.includes(m) : true) && !skipModules.includes(m);
let _rng = (parseInt(getArg('--seed', '42'), 10) || 42) >>> 0;
const rand = () => { _rng = (_rng * 1664525 + 1013904223) >>> 0; return _rng / 0x100000000; }; // deterministic LCG

// ── Parsing helpers ─────────────────────────────────────────────────────────
const KRT_HEADERS = ['RESOURCE TYPE', 'RESOURCE NAME', 'SOURCE', 'IDENTIFIER', 'NEW/REUSE', 'ADDITIONAL INFORMATION'];
const normHeader = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
const cellStr = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text || v.result || v.hyperlink || (Array.isArray(v.richText) ? v.richText.map(t => t.text).join('') : '') || '');
  return String(v);
};

/** Parse an author KRT file (csv or xlsx) into rows with the 6 standard columns. */
async function parseKrtFile(file) {
  let rows = [];
  if (file.toLowerCase().endsWith('.csv')) {
    const parsed = Papa.parse(fs.readFileSync(file, 'utf-8'), { skipEmptyLines: true });
    rows = parsed.data.map(r => r.map(cellStr));
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    // Pick the first sheet that has a KRT header row.
    for (const ws of wb.worksheets) {
      const tmp = [];
      ws.eachRow({ includeEmpty: false }, (row) => tmp.push((row.values || []).slice(1).map(cellStr)));
      if (tmp.some(r => r.map(normHeader).filter(h => KRT_HEADERS.includes(h)).length >= 3)) { rows = tmp; break; }
    }
  }
  if (!rows.length) return [];
  // Find the header row, then map columns by name.
  const headerIdx = rows.findIndex(r => r.map(normHeader).filter(h => KRT_HEADERS.includes(h)).length >= 3);
  if (headerIdx === -1) return [];
  const header = rows[headerIdx].map(normHeader);
  const col = (name) => header.indexOf(name);
  const ci = {
    resourceType: col('RESOURCE TYPE'), resourceName: col('RESOURCE NAME'), source: col('SOURCE'),
    identifier: col('IDENTIFIER'), newReuse: col('NEW/REUSE'), additionalInformation: col('ADDITIONAL INFORMATION')
  };
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (ci[k] >= 0 && ci[k] < r.length ? String(r[ci[k]] || '').trim() : '');
    const resourceName = get('resourceName');
    const resourceType = get('resourceType');
    if (!resourceName && !resourceType) continue; // blank row
    out.push({
      id: `a${out.length + 1}`,
      resourceType, resourceName,
      source: get('source'), identifier: get('identifier'),
      newReuse: get('newReuse'), additionalInformation: get('additionalInformation')
    });
  }
  return out;
}

/** Parse summary.csv → array of { key, name, type, sharedKrt, sharedText, sharedSupp, optional }. */
function parseSummary(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = Papa.parse(fs.readFileSync(file, 'utf-8'), { header: true, skipEmptyLines: true });
  const bool = (v) => String(v || '').trim().toUpperCase() === 'TRUE';
  return parsed.data.map(r => ({
    key: summaryIdToKey(r['ASAP ID'] || ''),
    name: (r['Object Name'] || '').trim(),
    type: (r['Object Type'] || '').trim(),
    sharedKrt: bool(r['Objects Shared in KRT']),
    sharedText: bool(r['Objects Shared in Text']),
    sharedSupp: bool(r['Objects Shared in Supplemental Table']),
    onlyKrt: bool(r['Objects Only Mentioned in KRT (Not Shared)']),
    onlyText: bool(r['Objects Only Mentioned in Text (Not Shared)']),
    onlySupp: bool(r['Objects Only Mentioned in Supplemental Table (Not Shared)']),
    optional: bool(r['Object is Optional'])
  })).filter(r => r.key && r.name);
}

// ── ID mapping: documents and summary use different id schemes ──────────────
// (illustrative placeholders — real ids come from the gitignored input folder)
// doc:     XX1-000000-001-org-G-1        → key 000000|1|G
//          YY2-000YY2-002-org-G-1        → key 000YY2|2|G
// summary: ASAP-000000-001-0000XX-G-DS1  → key 000000|1|G
//          ASAP-000YY2-0002-G            → key 000YY2|2|G
// Join on project code + submission number (leading zeros normalized) + org letter.
function docIdToKey(docId) {
  const m = String(docId).match(/^[A-Za-z0-9]+-([A-Za-z0-9]+)-(\d+)-org-([A-Za-z])/);
  return m ? `${m[1].toUpperCase()}|${parseInt(m[2], 10)}|${m[3].toUpperCase()}` : null;
}
function summaryIdToKey(asapId) {
  const m = String(asapId).match(/^ASAP-([A-Za-z0-9]+)-(\d+)(?:-[A-Za-z0-9]+)?-([A-Za-z])(?:-DS\d+)?$/);
  return m ? `${m[1].toUpperCase()}|${parseInt(m[2], 10)}|${m[3].toUpperCase()}` : null;
}

// ── Author-KRT grouping (offline static map; mirrors the DB group order) ────
function authorGroup(resourceType) {
  const t = String(resourceType || '').toLowerCase().trim();
  if (t === 'dataset' || t === 'datasets') return 'dataset';
  if (['software/code', 'code/software', 'software', 'code'].includes(t)) return 'software';
  if (t === 'protocol' || t === 'protocols') return 'protocol';
  return 'material';
}

// ── Aligning Generated ↔ Author KRT lines ──────────────────────────────────
// Two signals only, in priority order, per the curator's instruction:
//   1. The AI's own decision — a skip/update decision links a generated line to
//      an author row (the model judged them the same resource); an add means the
//      model judged it novel.
//   2. Identifier-token match (DOI / RRID / accession).
// We deliberately do NOT fuzzy-match resource names across the two KRTs (author
// "FIJI v2.17.0" vs generated "Fiji" would never line up, and unrelated rows can
// collide). Exact name is used ONLY to re-link a line to its OWN decision row,
// where both sides come from the same source so the string is identical.

// Cross-KRT identifier match.
const identifierMatch = (a, b) => !!(a.identifier && b.identifier && identifiersMatch(a.identifier, b.identifier));
// Same-source link (a line ↔ its own decision row): identifier or exact name.
function sameLine(a, b) {
  if (identifierMatch(a, b)) return true;
  const na = normalizeName(a.resourceName), nb = normalizeName(b.resourceName);
  return !!na && na === nb;
}
// The AI decision that concerns a given generated line, if any.
const decisionForGenerated = (genLine, decisions) =>
  (decisions || []).find(d => d.generatedRow && sameLine(genLine, d.generatedRow)) || null;

// Is a generated line aligned to an author row? Primary: the AI decision
// (skip/update = aligned, add = novel). Fallback: identifier match.
function genInAuthor(genLine, authorRows, decisions) {
  const d = decisionForGenerated(genLine, decisions);
  if (d && d.action === 'add') return false;
  if (d && (d.action === 'skip' || d.action === 'update')) return true;
  return (authorRows || []).some(a => identifierMatch(genLine, a));
}
// Is an author row covered — aligned by an AI skip/update decision, or matched by
// identifier to some generated line?
function authorCovered(authorLine, generatedKrt, decisions) {
  const aligned = (decisions || []).some(d =>
    (d.action === 'skip' || d.action === 'update') && d.authorRow && sameLine(authorLine, d.authorRow));
  if (aligned) return true;
  return (generatedKrt || []).some(g => identifierMatch(authorLine, g));
}

// ── Detection (seed-independent: software + identifier — same for both passes) ──
let _idxPromise = null; // cache the promise so parallel docs share one load
function loadIdIndex() {
  if (_idxPromise) return _idxPromise;
  if (!fs.existsSync(IDENTIFIERS_DIR)) return Promise.resolve(null);
  _idxPromise = knownIdentifierIndex.loadIndex({ provider: createCsvProvider(IDENTIFIERS_DIR) });
  return _idxPromise;
}

async function safe(label, fn, errors, fallback = []) {
  try { return await fn(); }
  catch (e) { errors.push(`${label}: ${e.message}`); return fallback; }
}

async function detectSeedIndependent(pdfBuffer, markdown, fileName, errors) {
  // Mirror the app: detection modules fan out concurrently (here the two
  // KRT-independent ones; the seed-dependent ones run per pass). Each is
  // isolated by safe(), so one module failing never sinks the others.
  const [software, identifier] = await Promise.all([
    !moduleEnabled('software') ? Promise.resolve([]) : safe('software', async () => {
      const { resources } = await softwareService.detectSoftware(pdfBuffer, fileName);
      return dedupeKrtItems(softwareService.applySoftwarePolicy(softwareService.buildKrtItemsSoftware(resources)), 'software');
    }, errors),
    !moduleEnabled('identifier') ? Promise.resolve([]) : safe('identifier', async () => {
      const index = await loadIdIndex();
      if (!index) return [];
      const { matches } = identifierService.detectIdentifiers(markdown, index);
      const krt = identifierService.buildKrtItemsIdentifier(matches, markdown);
      return dedupeKrtItems(identifierService.enrichIdentifiers(krt).enriched, 'identifier');
    }, errors)
  ]);
  return { software, identifier };
}

/** One full pass: seed-dependent detectors + merge + LM consolidation + LM comparison. */
async function runPass(pdfBuffer, markdown, fileName, authorRows, seedIndependent, errors) {
  const byGroup = (g) => authorRows.filter(r => authorGroup(r.resourceType) === g);
  const datasetSeeds = datasetsService.buildAuthorDatasetSeeds(byGroup('dataset'));
  const protocolSeeds = buildAuthorSeeds(byGroup('protocol'));
  const materialSeeds = buildAuthorSeeds(byGroup('material'));

  // Seed-dependent detectors fan out concurrently, exactly as the app runs them
  // as independent parallel jobs; merge + LM consolidation below is the barrier.
  // Each returns { items, raw } so the trace keeps both the parsed KRT items and
  // the raw LM response. safe() falls back to that shape on error.
  const NONE = { items: [], raw: null };
  const [dsR, prR, maR] = await Promise.all([
    !moduleEnabled('datasets') ? Promise.resolve(NONE) : safe('datasets', async () => {
      const r = await datasetsService.detectDatasets(markdown, { authorDatasets: datasetSeeds });
      return { items: dedupeKrtItems(datasetsService.buildKrtItemsDatasets(r.resources), 'datasets'), raw: r.rawResponse || null };
    }, errors, NONE),
    !moduleEnabled('protocols') ? Promise.resolve(NONE) : safe('protocols', async () => {
      const r = await protocolsService.detectProtocols(markdown, { authorProtocols: protocolSeeds });
      return { items: dedupeKrtItems(protocolsService.buildKrtItemsProtocols(r.resources), 'protocols'), raw: r.rawResponse || null };
    }, errors, NONE),
    // Materials is author-seeded only — skipped when the author listed none (same as the app).
    (!moduleEnabled('materials') || materialSeeds.length === 0) ? Promise.resolve(NONE) : safe('materials', async () => {
      const r = await materialsService.detectMaterials(markdown, { authorMaterials: materialSeeds });
      return { items: dedupeKrtItems(materialsService.buildKrtItemsMaterials(r.resources), 'materials'), raw: r.rawResponse || null };
    }, errors, NONE)
  ]);
  const datasets = dsR.items, protocols = prR.items, materials = maR.items;

  const contributions = [
    { source: 'software_detection', items: seedIndependent.software },
    { source: 'identifier_detection', items: seedIndependent.identifier },
    { source: 'datasets_detection', items: datasets },
    { source: 'protocols_detection', items: protocols },
    { source: 'materials_detection', items: materials }
  ].filter(c => c.items && c.items.length);

  const candidates = mergeDetections(contributions);

  let generatedKrt = candidates;
  let consolidation = { items: candidates, dropped: [], usedLM: false, rawResponse: null };
  try { consolidation = await consolidateWithLM(candidates); generatedKrt = consolidation.items || candidates; }
  catch (e) { errors.push(`krt-generation: ${e.message}`); }

  let suggestions = [], decisions = [], comparisonRaw = null;
  await safe('comparison', async () => {
    const res = await compareKrts(authorRows, generatedKrt);
    suggestions = res.suggestions; decisions = res.decisions; comparisonRaw = res.rawResponse || null;
    return [];
  }, errors);

  // Full trace of this pass: every module's items, the merged candidates, the LM
  // consolidation (+ what it dropped) and the LM comparison decisions, plus each
  // stage's raw LM response (written to .txt files by writeTrace).
  const trace = {
    seeds: { datasets: datasetSeeds, protocols: protocolSeeds, materials: materialSeeds },
    modules: {
      software:   { enabled: moduleEnabled('software'),   count: seedIndependent.software.length,   items: seedIndependent.software },
      identifier: { enabled: moduleEnabled('identifier'), count: seedIndependent.identifier.length, items: seedIndependent.identifier },
      datasets:   { enabled: moduleEnabled('datasets'),   count: datasets.length,  items: datasets },
      protocols:  { enabled: moduleEnabled('protocols'),  count: protocols.length, items: protocols },
      materials:  { enabled: moduleEnabled('materials'),  count: materials.length, items: materials }
    },
    merge: { count: candidates.length, candidates },
    consolidation: {
      usedLM: consolidation.usedLM, keptCount: generatedKrt.length,
      droppedCount: (consolidation.dropped || []).length, dropped: consolidation.dropped || [], items: generatedKrt
    },
    comparison: { decisionCount: decisions.length, suggestionCount: suggestions.length, decisions, suggestions },
    raw: {
      datasets: dsR.raw, protocols: prR.raw, materials: maR.raw,
      'krt-generation': consolidation.rawResponse || null,
      'kr-comparison': comparisonRaw
    }
  };

  return { generatedKrt, suggestions, decisions, trace };
}

// ── Removal selection for pass B ────────────────────────────────────────────
/** Choose which author lines to remove, returning the removed rows (with their summary flags). */
function chooseRemovals(authorRows, summaryRows) {
  const annotated = authorRows.map(r => ({ row: r, summary: summaryFor(r.resourceName, summaryRows) }));
  let eligible;
  if (RANDOM_MODE) {
    eligible = annotated;
  } else {
    // "clearly detectable": shared in text or supplemental, and not optional.
    eligible = annotated.filter(a => a.summary && (a.summary.sharedText || a.summary.sharedSupp) && !a.summary.optional);
  }

  // Stratify by resource type so the modified KRT loses some of EACH data type,
  // not just whatever a single global shuffle happened to land on. Within each
  // type we drop a REMOVE_FRAC share, at least one row.
  const byType = new Map();
  for (const a of eligible) {
    const type = a.row.resourceType || '(none)';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(a);
  }
  const removed = [];
  for (const group of byType.values()) {
    const shuffled = [...group].sort(() => rand() - 0.5);
    const n = Math.max(1, Math.round(group.length * REMOVE_FRAC));
    removed.push(...shuffled.slice(0, n));
  }
  return removed;
}

// ── Trace writers (full audit trail of inputs, module results, LM responses) ──
// Layout:  <out>/traces/<docId>/
//   inputs.json                     author KRT (A), removed rows, modified KRT (B)
//   original.trace.json             pass A: seeds, per-module items, merged
//   modified.trace.json             pass B   candidates, consolidation, decisions
//   original.raw/<stage>.txt        raw LM response per stage (datasets, protocols,
//   modified.raw/<stage>.txt        materials, krt-generation, kr-comparison)
function traceDir(docId) { return path.join(OUT_DIR, 'traces', docId); }

function writeInputs(docId, authorRows, modifiedRows, removed) {
  const base = traceDir(docId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'inputs.json'), JSON.stringify({
    authorKrt: authorRows,
    removedForModified: removed.map(r => ({ row: r.row, summary: r.summary })),
    modifiedKrt: modifiedRows
  }, null, 2));
}

function writeTrace(docId, passName, trace) {
  const base = traceDir(docId);
  const rawDir = path.join(base, `${passName}.raw`);
  fs.mkdirSync(rawDir, { recursive: true });
  const { raw, ...structured } = trace;
  fs.writeFileSync(path.join(base, `${passName}.trace.json`), JSON.stringify(structured, null, 2));
  for (const [stage, text] of Object.entries(raw || {})) {
    if (text == null) continue;
    fs.writeFileSync(path.join(rawDir, `${stage}.txt`), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  }
}

// ── xlsx writers ────────────────────────────────────────────────────────────
function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || 22 }));
  rows.forEach(r => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  return ws;
}
const modulesOf = (item) => [...new Set((item.detectedBy || []).map(d => d.source).filter(Boolean))]
  .map(s => ({ software_detection: 'SW', datasets_detection: 'DS', materials_detection: 'MAT', protocols_detection: 'PROT', identifier_detection: 'ID' }[s] || s)).join(', ');

function generatedRows(generatedKrt, authorRows, decisions) {
  return generatedKrt.map((g, i) => ({
    '#': i + 1, type: g.resourceType, name: g.resourceName, source: g.sourceUrl || '',
    identifier: g.identifier || '', newReuse: g.newReuse || '', modules: modulesOf(g),
    inAuthorKrt: genInAuthor(g, authorRows, decisions) ? 'yes' : 'NO (novel)', reason: g.reason || ''
  }));
}
function decisionRows(decisions) {
  const label = { add: 'Add', skip: 'Skip', update: 'Update', remove: 'Remove' };
  return decisions.map(d => {
    const row = d.authorRow || d.generatedRow || {};
    const short = (d.sources || []).map(s => ({ software_detection: 'SW', datasets_detection: 'DS', materials_detection: 'MAT', protocols_detection: 'PROT', identifier_detection: 'ID' }[s] || s)).join(', ');
    return {
      decision: label[d.action] || d.action, name: d.resourceName || row.resourceName || '',
      type: row.resourceType || '', identifier: row.identifier || '', newReuse: row.newReuse || '',
      changes: d.changes ? Object.entries(d.changes).map(([k, v]) => `${k}: "${v.old}"→"${v.new}"`).join('; ') : '',
      modules: short, reason: d.reason || ''
    };
  });
}

const GEN_COLS = [
  { header: '#', key: '#', width: 5 }, { header: 'Resource Type', key: 'type', width: 24 },
  { header: 'Resource Name', key: 'name', width: 40 }, { header: 'Source', key: 'source', width: 18 },
  { header: 'Identifier', key: 'identifier', width: 26 }, { header: 'New/Reuse', key: 'newReuse', width: 10 },
  { header: 'Modules', key: 'modules', width: 14 }, { header: 'In Author KRT?', key: 'inAuthorKrt', width: 14 },
  { header: 'Reason', key: 'reason', width: 60 }
];
const SUG_COLS = [
  { header: 'Decision', key: 'decision', width: 10 }, { header: 'Resource Name', key: 'name', width: 40 },
  { header: 'Resource Type', key: 'type', width: 24 }, { header: 'Identifier', key: 'identifier', width: 26 },
  { header: 'New/Reuse', key: 'newReuse', width: 10 }, { header: 'Changes', key: 'changes', width: 40 },
  { header: 'Modules', key: 'modules', width: 14 }, { header: 'Reason', key: 'reason', width: 60 }
];

// Author KRT sheet (the input). For the modified pass, the removed lines are
// appended at the end tagged 'REMOVED'.
const AUTHOR_COLS = [
  { header: '#', key: '#', width: 5 }, { header: 'Resource Type', key: 'type', width: 24 },
  { header: 'Resource Name', key: 'name', width: 40 }, { header: 'Source', key: 'source', width: 18 },
  { header: 'Identifier', key: 'identifier', width: 26 }, { header: 'New/Reuse', key: 'newReuse', width: 10 },
  { header: 'Additional Info', key: 'additionalInformation', width: 30 }, { header: 'Tag', key: 'tag', width: 11 }
];
function authorSheetRows(keptRows, removedRows = []) {
  const mk = (r, tag) => ({
    type: r.resourceType || '', name: r.resourceName || '', source: r.source || '',
    identifier: r.identifier || '', newReuse: r.newReuse || '', additionalInformation: r.additionalInformation || '', tag
  });
  const out = [...keptRows.map(r => mk(r, '')), ...removedRows.map(r => mk(r, 'REMOVED'))];
  out.forEach((o, i) => { o['#'] = i + 1; });
  return out;
}

// Match a KRT line to its summary.csv row by name (same fuzzy join used to pick
// removals): exact normalized-name first, then containment either way.
function summaryFor(name, summaryRows) {
  const nn = normalizeName(name);
  if (!nn) return null;
  return (summaryRows || []).find(s => normalizeName(s.name) === nn)
    || (summaryRows || []).find(s => { const sn = normalizeName(s.name); return sn && (sn.includes(nn) || nn.includes(sn)); })
    || null;
}
// Reference signals from summary.csv: was the resource mentioned somewhere a
// detector could have seen it (text / supplemental), i.e. did detection even
// have a chance? Used mainly to read "Author only (not generated)" misses.
function summarySignals(name, summaryRows) {
  const s = summaryFor(name, summaryRows);
  if (!s) return { inText: '—', inSupp: '—', optional: '—', detectable: 'not in summary.csv' };
  const inText = s.sharedText || s.onlyText;
  const inSupp = s.sharedSupp || s.onlySupp;
  const yn = (b) => (b ? 'yes' : 'no');
  const detectable = inText ? 'Yes — in text'
    : inSupp ? 'Yes — supplemental only'
    : 'No — KRT only';
  return { inText: yn(inText), inSupp: yn(inSupp), optional: yn(s.optional), detectable };
}

// Diff summary: Author KRT vs Generated KRT, with the AI decision per line and
// the summary.csv "was it mentioned in the text/supplemental?" reference signal.
const SUMMARY_COLS = [
  { header: 'Status', key: 'status', width: 28 }, { header: 'Resource Type', key: 'type', width: 24 },
  { header: 'Resource Name', key: 'name', width: 40 }, { header: 'Identifier', key: 'identifier', width: 26 },
  { header: 'Modules', key: 'modules', width: 14 }, { header: 'AI Note', key: 'note', width: 30 },
  { header: 'In Text (ref)', key: 'inText', width: 12 }, { header: 'In Suppl. (ref)', key: 'inSupp', width: 13 },
  { header: 'Optional (ref)', key: 'optional', width: 12 }, { header: 'Detectable? (ref)', key: 'detectable', width: 22 }
];
function aiNote(genLine, decisions) {
  const d = decisionForGenerated(genLine, decisions);
  if (!d) return '—';
  return ({ add: 'Suggested (add)', skip: 'Skipped (already in author KRT)', update: 'Suggested (update)' })[d.action] || d.action;
}
function buildSummary(generatedKrt, authorRows, decisions, summaryRows) {
  const rows = generatedKrt.map(g => ({
    status: genInAuthor(g, authorRows, decisions) ? 'In both (Author + Generated)' : 'Generated only (novel)',
    type: g.resourceType, name: g.resourceName, identifier: g.identifier || '',
    modules: modulesOf(g), note: aiNote(g, decisions), ...summarySignals(g.resourceName, summaryRows)
  }));
  // The other side of the diff: author lines detection did NOT align to. The
  // reference signal tells whether each miss was even detectable from the text.
  for (const a of authorRows) {
    if (!authorCovered(a, generatedKrt, decisions)) {
      rows.push({
        status: 'Author only (not generated)', type: a.resourceType, name: a.resourceName,
        identifier: a.identifier || '', modules: '', note: '', ...summarySignals(a.resourceName, summaryRows)
      });
    }
  }
  return rows;
}

// Run `worker` over `items` with at most `size` in flight; preserves order.
async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const lane = async () => { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, Math.max(1, items.length)) }, lane));
  return results;
}

// Markdown, cached on disk at <dir>/markdown/<id>.md. Converted once (Docling),
// then reused on every later run unless --refresh-markdown is given.
async function getMarkdown(doc, errors, pdfBuffer = null) {
  const cachePath = path.join(MD_DIR, `${doc.id}.md`);
  if (!REFRESH_MARKDOWN && fs.existsSync(cachePath)) {
    return { markdown: fs.readFileSync(cachePath, 'utf-8'), cached: true };
  }
  const markdown = await safe('markdown', async () => {
    const buf = pdfBuffer || fs.readFileSync(doc.pdf);
    return await convertToMarkdown(buf, path.basename(doc.pdf));
  }, errors);
  if (markdown && String(markdown).trim()) {
    fs.mkdirSync(MD_DIR, { recursive: true });
    fs.writeFileSync(cachePath, markdown);
  }
  return { markdown, cached: false };
}

// ── Per-document run ────────────────────────────────────────────────────────
async function processDoc(doc, summaryAll) {
  // --markdown-only: just (re)generate + cache the markdown, then stop. No KRT needed.
  if (MARKDOWN_ONLY) {
    const errs = [];
    const { markdown, cached } = await getMarkdown(doc, errs);
    if (markdown && String(markdown).trim()) {
      console.log(`  ${doc.id}: markdown ${cached ? 'already cached' : 'converted + cached'} (${markdown.length} chars)`);
      return { id: doc.id, markdownOnly: true };
    }
    console.log(`  ! ${doc.id}: markdown failed — ${errs.join('; ')}`);
    return null;
  }

  const summaryRows = summaryAll.filter(s => s.key === doc.key);
  const authorRows = await parseKrtFile(doc.krtFile);
  if (!authorRows.length) { console.log(`  ! ${doc.id}: KRT parsed to 0 rows — skipping`); return null; }

  // Pass B removal plan (computed offline, used for both plan + run)
  const removed = SKIP_MODIFIED ? [] : chooseRemovals(authorRows, summaryRows);
  const removedIds = new Set(removed.map(r => r.row.id));
  const modifiedRows = authorRows.filter(r => !removedIds.has(r.id)).map((r, i) => ({ ...r, id: `a${i + 1}` }));

  console.log(`  ${doc.id}: ${authorRows.length} KRT rows, ${summaryRows.length} summary rows, removing ${removed.length} for pass B`);
  if (PLAN_ONLY) {
    removed.forEach(r => console.log(`      - remove: [${r.row.resourceType}] ${r.row.resourceName}` +
      (r.summary ? `  (text=${r.summary.sharedText} supp=${r.summary.sharedSupp} opt=${r.summary.optional})` : '  (no summary match)')));
    return { id: doc.id, removedCount: removed.length, krtRows: authorRows.length };
  }

  const errors = [];
  const pdfBuffer = fs.readFileSync(doc.pdf);
  const { markdown, cached } = await getMarkdown(doc, errors, pdfBuffer);
  if (!markdown || !String(markdown).trim()) { console.log(`  ! ${doc.id}: markdown conversion failed — skipping (${errors.join('; ')})`); return null; }
  if (cached) console.log(`  ${doc.id}: using cached markdown`);
  const seedIndependent = await detectSeedIndependent(pdfBuffer, markdown, path.basename(doc.pdf), errors);

  const passA = await runPass(pdfBuffer, markdown, path.basename(doc.pdf), authorRows, seedIndependent, errors);
  const passB = SKIP_MODIFIED ? null : await runPass(pdfBuffer, markdown, path.basename(doc.pdf), modifiedRows, seedIndependent, errors);

  // Full audit trail: inputs + every module/LM stage for both passes.
  if (TRACE) {
    writeInputs(doc.id, authorRows, modifiedRows, removed);
    writeTrace(doc.id, 'original', passA.trace);
    if (passB) writeTrace(doc.id, 'modified', passB.trace);
  }

  // Build per-document workbook — sheets in the requested order
  // (Modified sheets only when pass B ran).
  const wb = new ExcelJS.Workbook();
  addSheet(wb, 'Original - Summary', SUMMARY_COLS, buildSummary(passA.generatedKrt, authorRows, passA.decisions, summaryRows));
  addSheet(wb, 'Original - AI Suggestions', SUG_COLS, decisionRows(passA.decisions));
  addSheet(wb, 'Original - Author KRT', AUTHOR_COLS, authorSheetRows(authorRows));
  addSheet(wb, 'Original - Generated KRT', GEN_COLS, generatedRows(passA.generatedKrt, authorRows, passA.decisions));
  if (passB) {
    addSheet(wb, 'Modified - Summary', SUMMARY_COLS, buildSummary(passB.generatedKrt, modifiedRows, passB.decisions, summaryRows));
    addSheet(wb, 'Modified - AI Suggestions', SUG_COLS, decisionRows(passB.decisions));
    addSheet(wb, 'Modified - Author KRT', AUTHOR_COLS, authorSheetRows(modifiedRows, removed.map(r => r.row)));
    addSheet(wb, 'Modified - Generated KRT', GEN_COLS, generatedRows(passB.generatedKrt, modifiedRows, passB.decisions));
  }
  if (errors.length) addSheet(wb, 'Errors', [{ header: 'Module error', key: 'e', width: 100 }], errors.map(e => ({ e })));

  // Recall data — kept for the GLOBAL summary (_summary.xlsx), no longer a per-doc sheet.
  let removedReport = [];
  if (passB) {
    // Recall signals, per the same rule: did the AI re-suggest adding it (its own
    // decision), or does it match a generated line by identifier?
    const addDecisions = passB.decisions.filter(d => d.action === 'add' && d.generatedRow);
    removedReport = removed.map(r => {
      const reSuggested = addDecisions.some(d => sameLine(r.row, d.generatedRow));
      const reDetected = reSuggested || passB.generatedKrt.some(g => identifierMatch(r.row, g));
      return {
        type: r.row.resourceType, name: r.row.resourceName, identifier: r.row.identifier,
        sharedKrt: r.summary?.sharedKrt ?? '', sharedText: r.summary?.sharedText ?? '', sharedSupp: r.summary?.sharedSupp ?? '',
        onlyKrt: r.summary?.onlyKrt ?? '', onlyText: r.summary?.onlyText ?? '', onlySupp: r.summary?.onlySupp ?? '',
        optional: r.summary?.optional ?? '', reDetected: reDetected ? 'yes' : 'NO', reSuggested: reSuggested ? 'yes' : 'NO'
      };
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT_DIR, `${doc.id}.xlsx`));

  return {
    id: doc.id, krtRows: authorRows.length,
    genA: passA.generatedKrt.length, addA: passA.suggestions.filter(s => s.type === 'add_row').length,
    novelA: passA.generatedKrt.filter(g => !genInAuthor(g, authorRows, passA.decisions)).length,
    removed: removed.length,
    reDetected: removedReport.filter(r => r.reDetected === 'yes').length,
    reSuggested: removedReport.filter(r => r.reSuggested === 'yes').length,
    removedReport, errors: errors.length
  };
}

// ── Document discovery ──────────────────────────────────────────────────────
function discoverDocuments() {
  if (!fs.existsSync(DOC_DIR)) { console.error(`Documents dir not found: ${DOC_DIR}`); process.exit(1); }
  const files = fs.readdirSync(DOC_DIR);
  const pdfs = files.filter(f => f.toLowerCase().endsWith('.pdf'));
  const docs = [];
  for (const pdf of pdfs) {
    const id = pdf.replace(/\.pdf$/i, '');
    if (ONLY_DOCS.length && !ONLY_DOCS.includes(id)) continue;
    const krtFile = [`${id}.xlsx`, `${id}.csv`].map(n => path.join(DOC_DIR, n)).find(p => fs.existsSync(p));
    if (!krtFile && !MARKDOWN_ONLY) { console.log(`  - ${id}: no KRT file — skipping`); continue; }
    const key = docIdToKey(id);
    docs.push({ id, pdf: path.join(DOC_DIR, pdf), krtFile: krtFile || null, key });
  }
  return docs;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const summaryAll = parseSummary(path.join(ROOT, 'summary.csv'));
  console.log(`summary.csv: ${summaryAll.length} object rows across ${new Set(summaryAll.map(s => s.key)).size} documents`);
  const docs = discoverDocuments();
  const enabledMods = ALL_MODULES.filter(moduleEnabled);
  const effConcurrency = PLAN_ONLY ? 1 : CONCURRENCY;
  const modeLabel = MARKDOWN_ONLY ? 'MARKDOWN ONLY (pre-warm cache)' : (PLAN_ONLY ? 'PLAN ONLY' : (RANDOM_MODE ? 'random removal' : 'detectable removal'));
  console.log(`Processing ${docs.length} document(s) [mode: ${modeLabel}` +
    `${MARKDOWN_ONLY ? '' : `, modules: ${enabledMods.join(',') || 'none'}`}, concurrency: ${effConcurrency}` +
    `${(MARKDOWN_ONLY || PLAN_ONLY) ? '' : `, trace: ${TRACE ? 'on' : 'off'}`}]\n`);

  const settled = await runPool(docs, effConcurrency, async (doc) => {
    if (!doc.key && !MARKDOWN_ONLY) console.log(`  ! ${doc.id}: could not derive summary key`);
    try { return await processDoc(doc, summaryAll); }
    catch (e) { console.error(`  ! ${doc.id}: ${e.message}`); return null; }
  });
  const results = settled.filter(Boolean);

  if (MARKDOWN_ONLY) { console.log(`\nDone — ${results.length} markdown file(s) cached in ${MD_DIR}`); return; }
  if (PLAN_ONLY || !results.length) { console.log('\nDone (plan).'); return; }

  // Global summary workbook
  const wb = new ExcelJS.Workbook();
  addSheet(wb, 'Per-document', [
    { header: 'Document', key: 'id', width: 30 }, { header: 'KRT rows', key: 'krtRows', width: 10 },
    { header: 'Generated (A)', key: 'genA', width: 12 }, { header: 'Novel-in-A (over-detection)', key: 'novelA', width: 24 },
    { header: 'Add suggestions (A)', key: 'addA', width: 18 }, { header: 'Removed (B)', key: 'removed', width: 11 },
    { header: 'Re-detected (B)', key: 'reDetected', width: 14 }, { header: 'Re-suggested (B)', key: 'reSuggested', width: 15 },
    { header: 'Module errors', key: 'errors', width: 13 }
  ], results.map(r => ({ ...r })));

  // Recall by Object Type
  const allRemoved = results.flatMap(r => r.removedReport || []);
  const byType = {};
  for (const r of allRemoved) {
    const t = r.type || '(none)';
    byType[t] = byType[t] || { type: t, removed: 0, reDetected: 0, reSuggested: 0 };
    byType[t].removed++; if (r.reDetected === 'yes') byType[t].reDetected++; if (r.reSuggested === 'yes') byType[t].reSuggested++;
  }
  addSheet(wb, 'Recall by type', [
    { header: 'Object Type', key: 'type', width: 28 }, { header: 'Removed', key: 'removed', width: 10 },
    { header: 'Re-detected', key: 'reDetected', width: 12 }, { header: 'Re-suggested', key: 'reSuggested', width: 12 },
    { header: 'Detect recall', key: 'dr', width: 13 }, { header: 'Suggest recall', key: 'sr', width: 13 }
  ], Object.values(byType).map(v => ({ ...v, dr: v.removed ? (v.reDetected / v.removed).toFixed(2) : '', sr: v.removed ? (v.reSuggested / v.removed).toFixed(2) : '' })));

  // Recall by sharing / mention flag (a removed line can carry several flags,
  // so these subsets overlap — each row is recall CONDITIONED on that flag).
  const FLAGS = [
    { key: 'sharedKrt', label: 'Shared in KRT' },
    { key: 'sharedText', label: 'Shared in Text' },
    { key: 'sharedSupp', label: 'Shared in Supplemental' },
    { key: 'onlyKrt', label: 'Only Mentioned in KRT' },
    { key: 'onlyText', label: 'Only Mentioned in Text' },
    { key: 'onlySupp', label: 'Only Mentioned in Supplemental' },
    { key: 'optional', label: 'Optional' }
  ];
  const byFlag = FLAGS.map(f => {
    const subset = allRemoved.filter(r => r[f.key] === true);
    const det = subset.filter(r => r.reDetected === 'yes').length;
    const sug = subset.filter(r => r.reSuggested === 'yes').length;
    return {
      flag: f.label, removed: subset.length, reDetected: det, reSuggested: sug,
      dr: subset.length ? (det / subset.length).toFixed(2) : '', sr: subset.length ? (sug / subset.length).toFixed(2) : ''
    };
  });
  // Lines with NO summary match (all flags blank) — surfaced so they aren't invisible.
  const noFlag = allRemoved.filter(r => !FLAGS.some(f => r[f.key] === true));
  if (noFlag.length) {
    const det = noFlag.filter(r => r.reDetected === 'yes').length, sug = noFlag.filter(r => r.reSuggested === 'yes').length;
    byFlag.push({ flag: '(no summary match)', removed: noFlag.length, reDetected: det, reSuggested: sug,
      dr: (det / noFlag.length).toFixed(2), sr: (sug / noFlag.length).toFixed(2) });
  }
  addSheet(wb, 'Recall by sharing', [
    { header: 'Sharing / mention flag', key: 'flag', width: 32 }, { header: 'Removed (with flag)', key: 'removed', width: 18 },
    { header: 'Re-detected', key: 'reDetected', width: 12 }, { header: 'Re-suggested', key: 'reSuggested', width: 12 },
    { header: 'Detect recall', key: 'dr', width: 13 }, { header: 'Suggest recall', key: 'sr', width: 13 }
  ], byFlag);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT_DIR, '_summary.xlsx'));

  const totRemoved = allRemoved.length, totDet = allRemoved.filter(r => r.reDetected === 'yes').length, totSug = allRemoved.filter(r => r.reSuggested === 'yes').length;
  console.log(`\nWrote ${results.length} document workbook(s) + _summary.xlsx to ${OUT_DIR}`);
  if (totRemoved) console.log(`Recall over ${totRemoved} removed lines — re-detected: ${totDet} (${(100 * totDet / totRemoved).toFixed(0)}%), re-suggested: ${totSug} (${(100 * totSug / totRemoved).toFixed(0)}%)`);
})().catch(e => { console.error(e); process.exit(1); });
