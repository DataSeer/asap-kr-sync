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
 *   Pass C (no KRT):  detection + comparison with NO author KRT at all (cold
 *     start). Measures recall of the FULL author KRT from scratch. Materials are
 *     run article-only here (the app skips them without seeds) to measure whether
 *     unseeded material detection is worth enabling. Off via --skip-empty.
 *
 * Together the three passes give the app's behaviour across Complete / Partial /
 * No author KRT.
 *
 * Writes one xlsx per document with 5 tabs —
 *   Summary                              side-by-side Original vs Modified stats
 *                                        + per-author-line coverage (removed?,
 *                                        found in Original / Modified, re-suggested)
 *   Original/Modified - KRTs             author KRT aligned to the generated KRT
 *                                        (novel generated lines at the end) + the
 *                                        summary.csv reference signals per line
 *   Original/Modified - Cand. & Sugg.    every merged candidate (kept + rejected
 *                                        by LM consolidation, with reasons) and
 *                                        the AI suggestion made from it
 * (+ an Errors tab when a module failed) — plus a global _summary.xlsx with
 * recall metrics broken down by Object Type and the summary's "Shared in …" flags.
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
 *   --rebuild         regenerate the .xlsx reports from an existing run's traces
 *                     (<out>/traces/<id>/) — no PDF, no API. Use after changing
 *                     the report code, or to re-derive a saved run's stats:
 *                       --rebuild --out tmp/suggestions-quality/save/run-v3-1
 *   --modules a,b     only run these detection modules
 *   --skip-modules x  run all detection modules except these
 *                     (modules: software, datasets, protocols, materials, identifier)
 *   --concurrency N   process N documents in parallel (default 2)
 *   --random          pass B removes a random subset of ANY line (not just detectable)
 *   --remove-frac F   fraction to remove per resource type in pass B (default 0.5, min 1 per type)
 *   --seed N          RNG seed for deterministic removal (default 42)
 *   --skip-modified   skip pass B (the partial-KRT / removal pass)
 *   --skip-empty      skip pass C (the no-KRT / cold-start pass)
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
const { AsyncLocalStorage } = require('async_hooks');
const ExcelJS = require('exceljs');
const Papa = require('papaparse');

// ── Per-document log tagging ────────────────────────────────────────────────
// With --concurrency > 1 many documents log at once, so tag every line with the
// PDF name of the async context that emitted it. The id is read at LOG-CALL time
// (while the async context is still intact) and baked into the message. An
// earlier version instead prefixed process.stdout.write, but that reads the
// context at stream-write time — and winston buffers its records and flushes
// them on a later tick in the root context, by which point the id is gone, so
// the services' (winston) lines came out untagged. Wrapping the log methods
// themselves fixes that.
const logCtx = new AsyncLocalStorage();
const tagWithDocId = (fn) => (first, ...rest) => {
  const id = logCtx.getStore();
  return (id && typeof first === 'string') ? fn(`[${id}] ${first}`, ...rest) : fn(first, ...rest);
};
// The script's own logging (and any service that logs via console directly).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[method].bind(console);
  console[method] = tagWithDocId(orig);
}

require('dotenv').config({ path: path.join(__dirname, '../.env') });

// The pipeline services log through the app's winston logger (a singleton the
// service requires all share). Wrap its level methods the same way so their
// lines carry the PDF name too. Required here — after dotenv — so the logger
// reads its env config once, before any service does.
const appLogger = require('../src/backend/utils/logger');
for (const level of ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']) {
  if (typeof appLogger[level] !== 'function') continue;
  const orig = appLogger[level].bind(appLogger);
  appLogger[level] = tagWithDocId(orig);
}

// ── Pipeline imports (same code the app runs) ───────────────────────────────
const { convertToMarkdown } = require('../src/backend/services/pdf/pdf-markdown-client.service');
const markdownFilter = require('../src/backend/services/pdf/markdown-filter.service');
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
// The "empty" pass (C): run detection + comparison with NO author KRT at all —
// the cold-start case. Measures raw recall of the FULL author KRT from scratch
// (every generated line becomes an add). Unlike the app, which skips the
// materials module entirely when there are no author materials (request D), this
// pass runs materials UNSEEDED (article-only) so we can MEASURE whether cold-
// start material detection is worth enabling. On by default; --skip-empty off.
const SKIP_EMPTY = has('--skip-empty');
const PLAN_ONLY = has('--plan');
// Rebuild the .xlsx reports from an existing run's on-disk traces (no PDF, no
// API calls). Reads <out>/traces/<id>/ and rewrites <out>/<id>.xlsx + _summary.
// Use it to regenerate reports after changing the report/metric code, or to
// re-derive stats for a saved run (e.g. --rebuild --out .../save/run-v3-1).
const REBUILD = has('--rebuild');
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

// Degraded-comparison detection, derived purely from the generated KRT + the LM
// decisions — so live runs and --rebuild (which reads decisions from the trace)
// produce identical flags. 0 usable (reviewed) decisions = a fully broken
// response; any 'unreviewed' rows = a partial comparison (the LM forgot refs).
function comparisonHealthErrors(generatedKrt, decisions) {
  const out = [];
  if (!generatedKrt.length) return out;
  const unreviewed = (decisions || []).filter(d => d.action === 'unreviewed').length;
  const reviewed = (decisions || []).length - unreviewed;
  if (reviewed === 0) {
    out.push(`comparison: 0 usable decisions for ${generatedKrt.length} generated rows — degraded/broken LM response (suggestions unavailable for this pass)`);
  } else if (unreviewed > 0) {
    out.push(`comparison: AI returned no decision for ${unreviewed}/${generatedKrt.length} generated rows (flagged 'unreviewed') — partial comparison`);
  }
  return out;
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

/**
 * One full pass: seed-dependent detectors + merge + LM consolidation + LM
 * comparison. opts.materialsUnseeded runs the materials module article-only even
 * when there are no author material seeds (the app skips it — request D); used
 * by the empty pass (C) to measure cold-start material detection.
 */
async function runPass(pdfBuffer, markdown, fileName, authorRows, seedIndependent, errors, opts = {}) {
  const byGroup = (g) => authorRows.filter(r => authorGroup(r.resourceType) === g);
  const datasetSeeds = datasetsService.buildAuthorDatasetSeeds(byGroup('dataset'));
  const protocolSeeds = buildAuthorSeeds(byGroup('protocol'));
  const materialSeeds = buildAuthorSeeds(byGroup('material'));
  const runMaterials = moduleEnabled('materials') && (materialSeeds.length > 0 || opts.materialsUnseeded);

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
    // Materials is author-seeded only in the app (skipped when the author listed
    // none); opts.materialsUnseeded forces it article-only for the empty pass.
    !runMaterials ? Promise.resolve(NONE) : safe('materials', async () => {
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

  // The app now retries transient failures AND empty/broken responses, and the
  // comparison flags every generated row it left undecided as an 'unreviewed'
  // decision. So the degraded signal here is precise: 0 usable (reviewed)
  // decisions = a fully broken response; any 'unreviewed' rows = a partial
  // comparison (the LM forgot some refs). Either corrupts recall silently, so
  // flag it loudly rather than letting it disappear into the metrics.
  let suggestions = [], decisions = [], comparisonRaw = null;
  await safe('comparison', async () => {
    const res = await compareKrts(authorRows, generatedKrt);
    suggestions = res.suggestions; decisions = res.decisions; comparisonRaw = res.rawResponse || null;
    return [];
  }, errors);
  for (const msg of comparisonHealthErrors(generatedKrt, decisions)) { errors.push(msg); console.warn(`  ! ${msg}`); }

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

function writeInputs(docId, authorRows, modifiedRows, removed, errors = []) {
  const base = traceDir(docId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'inputs.json'), JSON.stringify({
    authorKrt: authorRows,
    removedForModified: removed.map(r => ({ row: r.row, summary: r.summary })),
    modifiedKrt: modifiedRows,
    // Persisted so --rebuild can reproduce the Errors tab (module/transient
    // failures aren't in the per-stage trace). Older traces lack this — rebuild
    // then re-derives the degraded-comparison flags from the decisions instead.
    errors
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
const shortSources = (sources) => (sources || [])
  .map(s => ({ software_detection: 'SW', datasets_detection: 'DS', materials_detection: 'MAT', protocols_detection: 'PROT', identifier_detection: 'ID' }[s] || s)).join(', ');
const modulesOf = (item) => shortSources([...new Set((item.detectedBy || []).map(d => d.source).filter(Boolean))]);
const DECISION_LABEL = { add: 'Add', skip: 'Skip', update: 'Update', remove: 'Remove', unreviewed: 'Unreviewed' };
const fmtChanges = (changes) => changes
  ? Object.entries(changes).map(([k, v]) => `${k}: "${v.old}"→"${v.new}"`).join('; ') : '';

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

// ── KRTs sheet: author KRT ↔ generated KRT aligned side by side ─────────────
// One row per author line (kept first, then the REMOVED ones for the modified
// pass) with its aligned generated line — AI skip/update decision first, then an
// add decision naming the same resource (how a removed line comes back), then
// identifier match. Generated lines aligned to nothing are appended at the end
// as 'Generated only (new)'. The trailing (ref) columns are the summary.csv
// signals: was the resource even visible to detection (text / supplemental)?
const KRT_COLS = [
  { header: '#', key: '#', width: 5 }, { header: 'Status', key: 'status', width: 27 },
  { header: 'A: Resource Type', key: 'aType', width: 22 }, { header: 'A: Resource Name', key: 'aName', width: 36 },
  { header: 'A: Source', key: 'aSource', width: 16 }, { header: 'A: Identifier', key: 'aId', width: 24 },
  { header: 'A: New/Reuse', key: 'aNewReuse', width: 12 }, { header: 'A: Additional Info', key: 'aInfo', width: 26 },
  { header: 'G: Resource Type', key: 'gType', width: 22 }, { header: 'G: Resource Name', key: 'gName', width: 36 },
  { header: 'G: Source', key: 'gSource', width: 16 }, { header: 'G: Identifier', key: 'gId', width: 24 },
  { header: 'G: New/Reuse', key: 'gNewReuse', width: 12 }, { header: 'G: Modules', key: 'gModules', width: 12 },
  { header: 'G: AI Decision', key: 'gDecision', width: 14 }, { header: 'G: Reason', key: 'gReason', width: 55 },
  { header: 'In Text (ref)', key: 'inText', width: 12 }, { header: 'In Suppl. (ref)', key: 'inSupp', width: 13 },
  { header: 'Optional (ref)', key: 'optional', width: 12 }, { header: 'Detectable? (ref)', key: 'detectable', width: 22 }
];
function genCells(g, decisions) {
  const d = decisionForGenerated(g, decisions);
  return {
    gType: g.resourceType || '', gName: g.resourceName || '', gSource: g.sourceUrl || '',
    gId: g.identifier || '', gNewReuse: g.newReuse || '', gModules: modulesOf(g),
    gDecision: d ? (DECISION_LABEL[d.action] || d.action) : '—', gReason: g.reason || ''
  };
}
function buildKrtRows(keptRows, removedRows, generatedKrt, decisions, summaryRows) {
  const entries = [...keptRows.map(r => ({ row: r, removed: false })), ...removedRows.map(r => ({ row: r, removed: true }))];
  const used = new Set();
  const claimGen = (pred) => {
    const i = generatedKrt.findIndex((g, idx) => !used.has(idx) && pred(g));
    if (i === -1) return null;
    used.add(i);
    return generatedKrt[i];
  };
  const rows = [];
  for (const e of entries) {
    const a = e.row;
    const g = claimGen(x => { const d = decisionForGenerated(x, decisions); return !!(d && (d.action === 'skip' || d.action === 'update') && d.authorRow && sameLine(a, d.authorRow)); })
      || claimGen(x => { const d = decisionForGenerated(x, decisions); return !!(d && d.action === 'add' && d.generatedRow && sameLine(a, d.generatedRow)); })
      || claimGen(x => identifierMatch(a, x));
    // An author line the AI explicitly suggested deleting still shows a decision.
    const removeDecision = !g && (decisions || []).find(d => d.action === 'remove' && d.authorRow && sameLine(a, d.authorRow));
    rows.push({
      status: e.removed ? (g ? 'REMOVED — re-detected' : 'REMOVED — not re-detected')
        : (g ? 'In both (Author + Generated)' : 'Author only (not generated)'),
      aType: a.resourceType || '', aName: a.resourceName || '', aSource: a.source || '',
      aId: a.identifier || '', aNewReuse: a.newReuse || '', aInfo: a.additionalInformation || '',
      ...(g ? genCells(g, decisions) : { gDecision: removeDecision ? 'Remove' : '', gReason: removeDecision ? (removeDecision.reason || '') : '' }),
      ...summarySignals(a.resourceName, summaryRows)
    });
  }
  generatedKrt.forEach((g, i) => {
    if (used.has(i)) return;
    rows.push({ status: 'Generated only (new)', ...genCells(g, decisions), ...summarySignals(g.resourceName, summaryRows) });
  });
  rows.forEach((r, i) => { r['#'] = i + 1; });
  return rows;
}

// ── Candidates & Suggestions sheet ──────────────────────────────────────────
// Every merged detection candidate: the ones consolidation KEPT (one per
// generated KRT line, with the consolidation reason) carry the AI suggestion
// made from them on the same row; the ones it REJECTED carry the drop reason.
// 'Remove' suggestions target an author row (no candidate) — listed at the end.
// The trailing "Curator Label" column is for measuring the tool's real goal
// (issue #5): a curator marks each AI **Add** suggestion TP (a genuinely missing
// KRT item) or FP (noise) so precision can be computed. Left blank by the script
// for actionable Add/Update/Remove rows; 'n/a' for skips/rejections that aren't
// suggestions. NOTE: labels live in the sheet, so re-running --rebuild overwrites
// them — copy a labelled sheet aside before rebuilding, or keep labels separately.
const CAND_COLS = [
  { header: '#', key: '#', width: 5 }, { header: 'Candidate', key: 'status', width: 12 },
  { header: 'Resource Type', key: 'type', width: 24 }, { header: 'Resource Name', key: 'name', width: 40 },
  { header: 'Source', key: 'source', width: 18 }, { header: 'Identifier', key: 'identifier', width: 26 },
  { header: 'New/Reuse', key: 'newReuse', width: 10 }, { header: 'Modules', key: 'modules', width: 14 },
  { header: 'Consolidation Reason', key: 'consReason', width: 45 },
  { header: 'AI Suggestion', key: 'decision', width: 14 }, { header: 'Changes', key: 'changes', width: 40 },
  { header: 'Suggestion Reason', key: 'sugReason', width: 55 },
  { header: 'Curator Label (TP/FP)', key: 'label', width: 18 }
];
// TP/FP labelling applies only to actionable suggestions the tool is asserting.
const labelCell = (action) => (action === 'add' || action === 'update' || action === 'remove') ? '' : 'n/a';
function buildCandSuggRows(trace, decisions) {
  const rows = [];
  for (const g of trace.consolidation.items) {
    const d = decisionForGenerated(g, decisions);
    rows.push({
      status: 'Kept', type: g.resourceType || '', name: g.resourceName || '', source: g.sourceUrl || '',
      identifier: g.identifier || '', newReuse: g.newReuse || '', modules: modulesOf(g),
      consReason: g.reason || '', decision: d ? (DECISION_LABEL[d.action] || d.action) : '—',
      changes: fmtChanges(d?.changes), sugReason: d?.reason || '', label: labelCell(d?.action)
    });
  }
  for (const c of trace.consolidation.dropped) {
    rows.push({
      status: 'Rejected', type: c.resourceType || '', name: c.resourceName || '',
      identifier: c.identifier || '', modules: shortSources(c.sources), consReason: c.reason || '', label: 'n/a'
    });
  }
  for (const d of (decisions || []).filter(x => x.action === 'remove')) {
    rows.push({
      status: '— (author row)', type: d.authorRow?.resourceType || '', name: d.resourceName || '',
      identifier: d.authorRow?.identifier || '', decision: 'Remove', sugReason: d.reason || '', label: labelCell('remove')
    });
  }
  rows.forEach((r, i) => { r['#'] = i + 1; });
  return rows;
}

// ── Summary sheet: Original vs Modified at a glance ─────────────────────────
// Two stacked tables: the stats block (these 4 columns), then a per-author-line
// coverage table appended below by appendCoverageTable(). Widths are shared per
// column index across both tables, hence the generous B/C/D widths here.
const RUN_SUMMARY_COLS = [
  { header: 'Metric', key: 'metric', width: 40 }, { header: 'Complete KRT (A)', key: 'a', width: 18 },
  { header: 'Partial KRT (B)', key: 'b', width: 18 }, { header: 'No KRT (C)', key: 'c', width: 18 },
  { header: 'What it tells you', key: 'note', width: 62 }
];
function passStats(pass, authorRows) {
  const aligned = pass.generatedKrt.filter(g => genInAuthor(g, authorRows, pass.decisions)).length;
  const dec = (a) => pass.decisions.filter(d => d.action === a).length;
  return {
    authorRows: authorRows.length,
    candidates: pass.trace.merge.count,
    rejected: pass.trace.consolidation.droppedCount,
    generated: pass.generatedKrt.length,
    aligned,
    novel: pass.generatedKrt.length - aligned,
    add: dec('add'), skip: dec('skip'), update: dec('update'), remove: dec('remove')
  };
}
// Empty pass: no author rows were seeded, so alignment to the (full) author KRT
// is measured by identifier/name match, not by the LM's decisions (all 'add').
function passStatsEmpty(pass, authorRows) {
  const matchesAuthor = (g) => authorRows.some(a => identifierMatch(a, g) || sameLine(a, g));
  const aligned = pass.generatedKrt.filter(matchesAuthor).length;
  const dec = (a) => pass.decisions.filter(d => d.action === a).length;
  return {
    authorRows: 0, candidates: pass.trace.merge.count, rejected: pass.trace.consolidation.droppedCount,
    generated: pass.generatedKrt.length, aligned, novel: pass.generatedKrt.length - aligned,
    add: dec('add'), skip: dec('skip'), update: dec('update'), remove: dec('remove')
  };
}
function buildRunSummary({ passA, passB, passC, authorRows, modifiedRows, removed, removedReport, emptyReport, errorCount }) {
  const A = passStats(passA, authorRows);
  const B = passB ? passStats(passB, modifiedRows) : null;
  const C = passC ? passStatsEmpty(passC, authorRows) : null;
  const pct = (n, d) => (d ? `${n} (${Math.round(100 * n / d)}%)` : String(n));
  const g = (stats, key) => (stats ? stats[key] : '—');
  const gp = (stats, n, d) => (stats ? pct(stats[n], stats[d]) : '—');
  const row = (metric, a, b, c, note) => ({ metric, a, b, c, note });
  const reDetB = removedReport.filter(r => r.reDetected === 'yes').length;
  const reSugB = removedReport.filter(r => r.reSuggested === 'yes').length;
  const reDetC = emptyReport.filter(r => r.reDetected === 'yes').length;
  const reSugC = emptyReport.filter(r => r.reSuggested === 'yes').length;
  const N = authorRows.length;
  return [
    row('Author rows seeded into detection', A.authorRows, g(B, 'authorRows'), C ? 0 : '—', 'What detection was grounded on. C: none — cold start (materials run article-only)'),
    row('Candidates (PDF analysis, merged)', A.candidates, g(B, 'candidates'), g(C, 'candidates'), 'Detector output after merge, before LM consolidation'),
    row('Candidates rejected by consolidation', A.rejected, g(B, 'rejected'), g(C, 'rejected'), 'Reasons in the Cand. & Suggestions tabs'),
    row('Generated KRT lines (kept)', A.generated, g(B, 'generated'), g(C, 'generated'), 'Candidates kept by consolidation'),
    row('— matching a real author row', gp(A, 'aligned', 'generated'), gp(B, 'aligned', 'generated'), gp(C, 'aligned', 'generated'), 'Generated line corresponds to a full-KRT author item (identifier/name)'),
    row('— novel (not in author KRT)', gp(A, 'novel', 'generated'), gp(B, 'novel', 'generated'), gp(C, 'novel', 'generated'), 'Over-detection / author-omission signal'),
    row('AI suggestions — Add', A.add, g(B, 'add'), g(C, 'add'), 'C: every generated line is an add (nothing to compare against)'),
    row('AI suggestions — Update', A.update, g(B, 'update'), g(C, 'update'), ''),
    row('AI suggestions — Remove', A.remove, g(B, 'remove'), g(C, 'remove'), ''),
    row('AI decisions — Skip (already covered)', A.skip, g(B, 'skip'), g(C, 'skip'), ''),
    row('Recall target — author rows withheld', '—', removed.length, C ? N : '—', 'Rows detection did NOT see: B = the removed subset, C = the whole KRT'),
    row('Recall — re-detected', '—', passB ? pct(reDetB, removed.length) : '—', C ? pct(reDetC, N) : '—', 'Withheld row reappears in the Generated KRT'),
    row('Recall — re-suggested as Add', '—', passB ? pct(reSugB, removed.length) : '—', C ? pct(reSugC, N) : '—', 'Withheld row comes back as an Add suggestion — the end-to-end target'),
    row('Pipeline errors (see Errors tab)', errorCount, '', '', '')
  ];
}

// Per-line coverage table, appended BELOW the stats block on the same Summary
// sheet: one row per author KRT line — was it removed for pass B, did the
// Original pass generate it, did the Modified pass generate / re-suggest it.
// Same coverage rules as everywhere else: AI decision first, then identifier.
function appendCoverageTable(ws, authorRows, removed, passA, passB, passC) {
  const removedIds = new Set(removed.map(r => r.row.id));
  const yn = (b) => (b ? 'yes' : 'NO');
  const addDecisionsB = passB ? passB.decisions.filter(d => d.action === 'add' && d.generatedRow) : [];
  const addDecisionsC = passC ? passC.decisions.filter(d => d.action === 'add' && d.generatedRow) : [];
  const foundIn = (a, pass, adds) => yn(adds.some(d => sameLine(a, d.generatedRow)) || pass.generatedKrt.some(g => identifierMatch(a, g)));

  ws.addRow([]);
  const title = ws.addRow(['Author KRT coverage — per line (details in the KRTs tabs)']);
  title.font = { bold: true };
  const header = ws.addRow(['Removed (B)', 'Resource Type', 'Resource Name', 'Identifier',
    'Complete: Found', 'Partial: Found', 'Partial: Suggested', 'No KRT: Found']);
  header.font = { bold: true };
  [15, 15, 18, 15].forEach((w, i) => { ws.getColumn(5 + i).width = w; });

  for (const a of authorRows) {
    const isRemoved = removedIds.has(a.id);
    const origFound = yn(authorCovered(a, passA.generatedKrt, passA.decisions));
    let modFound = '—', modSuggested = '—';
    if (passB) {
      if (isRemoved) {
        const reSuggested = addDecisionsB.some(d => sameLine(a, d.generatedRow));
        modFound = yn(reSuggested || passB.generatedKrt.some(g => identifierMatch(a, g)));
        modSuggested = yn(reSuggested);
      } else {
        modFound = yn(authorCovered(a, passB.generatedKrt, passB.decisions));
      }
    }
    // No-KRT (cold start): found if the tool re-detected/re-suggested it from scratch.
    const emptyFound = passC ? foundIn(a, passC, addDecisionsC) : '—';
    ws.addRow([isRemoved ? 'yes' : '', a.resourceType || '', a.resourceName || '',
      a.identifier || '', origFound, modFound, modSuggested, emptyFound]);
  }
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
  let raw, cached;
  if (!REFRESH_MARKDOWN && fs.existsSync(cachePath)) {
    raw = fs.readFileSync(cachePath, 'utf-8'); cached = true;
  } else {
    raw = await safe('markdown', async () => {
      const buf = pdfBuffer || fs.readFileSync(doc.pdf);
      return await convertToMarkdown(buf, path.basename(doc.pdf));
    }, errors, null);
    if (raw && String(raw).trim()) {
      fs.mkdirSync(MD_DIR, { recursive: true });
      fs.writeFileSync(cachePath, raw); // cache RAW so the filter A/B can toggle without re-converting
    }
    cached = false;
  }
  // Apply the markdown filter at read time (gated by env), matching the app.
  const { markdown, applied, stats } = markdownFilter.applyFilter(raw || '');
  if (applied) console.log(`  markdown-filter ${stats.charsBefore}→${stats.charsAfter} chars (-${stats.charsDropped})`);
  return { markdown: raw ? markdown : raw, cached };
}

// ── Per-document run ────────────────────────────────────────────────────────
async function processDoc(doc, summaryAll) {
  // --markdown-only: just (re)generate + cache the markdown, then stop. No KRT needed.
  if (MARKDOWN_ONLY) {
    const errs = [];
    const { markdown, cached } = await getMarkdown(doc, errs);
    if (markdown && String(markdown).trim()) {
      console.log(`  markdown ${cached ? 'already cached' : 'converted + cached'} (${markdown.length} chars)`);
      return { id: doc.id, markdownOnly: true };
    }
    console.log(`  ! markdown failed — ${errs.join('; ')}`);
    return null;
  }

  const summaryRows = summaryAll.filter(s => s.key === doc.key);
  const authorRows = await parseKrtFile(doc.krtFile);
  if (!authorRows.length) { console.log(`  ! KRT parsed to 0 rows — skipping`); return null; }

  // Pass B removal plan (computed offline, used for both plan + run)
  const removed = SKIP_MODIFIED ? [] : chooseRemovals(authorRows, summaryRows);
  const removedIds = new Set(removed.map(r => r.row.id));
  const modifiedRows = authorRows.filter(r => !removedIds.has(r.id)).map((r, i) => ({ ...r, id: `a${i + 1}` }));

  console.log(`  ${authorRows.length} KRT rows, ${summaryRows.length} summary rows, removing ${removed.length} for pass B`);
  if (PLAN_ONLY) {
    removed.forEach(r => console.log(`      - remove: [${r.row.resourceType}] ${r.row.resourceName}` +
      (r.summary ? `  (text=${r.summary.sharedText} supp=${r.summary.sharedSupp} opt=${r.summary.optional})` : '  (no summary match)')));
    return { id: doc.id, removedCount: removed.length, krtRows: authorRows.length };
  }

  const errors = [];
  const pdfBuffer = fs.readFileSync(doc.pdf);
  const { markdown, cached } = await getMarkdown(doc, errors, pdfBuffer);
  if (!markdown || !String(markdown).trim()) { console.log(`  ! markdown conversion failed — skipping (${errors.join('; ')})`); return null; }
  if (cached) console.log('  using cached markdown');
  const seedIndependent = await detectSeedIndependent(pdfBuffer, markdown, path.basename(doc.pdf), errors);

  const fileName = path.basename(doc.pdf);
  const passA = await runPass(pdfBuffer, markdown, fileName, authorRows, seedIndependent, errors);
  const passB = SKIP_MODIFIED ? null : await runPass(pdfBuffer, markdown, fileName, modifiedRows, seedIndependent, errors);
  // Pass C — no author KRT at all (materials forced article-only, see runPass).
  const passC = SKIP_EMPTY ? null : await runPass(pdfBuffer, markdown, fileName, [], seedIndependent, errors, { materialsUnseeded: true });

  // Full audit trail: inputs + every module/LM stage for every pass.
  if (TRACE) {
    writeInputs(doc.id, authorRows, modifiedRows, removed, errors);
    writeTrace(doc.id, 'original', passA.trace);
    if (passB) writeTrace(doc.id, 'modified', passB.trace);
    if (passC) writeTrace(doc.id, 'empty', passC.trace);
  }

  return writeDocReport({ doc, authorRows, modifiedRows, removed, summaryRows, passA, passB, passC, errors });
}

// Recall over the removed lines: did the AI re-suggest adding it (its own
// decision), or does it match a generated line by identifier? Pure over the
// pass-B results, so it works for both live runs and --rebuild.
function computeRemovedReport(removed, passB) {
  if (!passB) return [];
  const addDecisions = passB.decisions.filter(d => d.action === 'add' && d.generatedRow);
  return removed.map(r => {
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

// Build + write one document's workbook and return its per-document summary row.
// Pure function of its context (generated KRT, decisions, suggestions, inputs) —
// the SAME entry point for a live pipeline pass and a --rebuild from traces, so
// both produce identical reports.
async function writeDocReport({ doc, authorRows, modifiedRows, removed, summaryRows, passA, passB, passC, errors }) {
  const removedReport = computeRemovedReport(removed, passB);
  // Pass C recall is over the FULL author KRT (every row is "withheld", since
  // detection was seeded with nothing) — reuse the same recall computation by
  // treating every author row as a removed line annotated with its summary flags.
  const authorAsRemoved = authorRows.map(a => ({ row: a, summary: summaryFor(a.resourceName, summaryRows) }));
  const emptyReport = passC ? computeRemovedReport(authorAsRemoved, passC) : [];

  const wb = new ExcelJS.Workbook();
  const wsSummary = addSheet(wb, 'Summary', RUN_SUMMARY_COLS,
    buildRunSummary({ passA, passB, passC, authorRows, modifiedRows, removed, removedReport, emptyReport, errorCount: errors.length }));
  appendCoverageTable(wsSummary, authorRows, removed, passA, passB, passC);
  addSheet(wb, 'Original - KRTs', KRT_COLS,
    buildKrtRows(authorRows, [], passA.generatedKrt, passA.decisions, summaryRows));
  addSheet(wb, 'Original - Cand. & Suggestions', CAND_COLS, buildCandSuggRows(passA.trace, passA.decisions));
  if (passB) {
    addSheet(wb, 'Modified - KRTs', KRT_COLS,
      buildKrtRows(modifiedRows, removed.map(r => r.row), passB.generatedKrt, passB.decisions, summaryRows));
    addSheet(wb, 'Modified - Cand. & Suggestions', CAND_COLS, buildCandSuggRows(passB.trace, passB.decisions));
  }
  if (passC) {
    // Empty pass: no seeded author rows; the full author KRT is the ground truth
    // (shown as the author side) against the cold-start generated KRT.
    addSheet(wb, 'Empty - KRTs', KRT_COLS,
      buildKrtRows(authorRows, [], passC.generatedKrt, passC.decisions, summaryRows));
    addSheet(wb, 'Empty - Cand. & Suggestions', CAND_COLS, buildCandSuggRows(passC.trace, passC.decisions));
  }
  if (errors.length) addSheet(wb, 'Errors', [{ header: 'Module error', key: 'e', width: 100 }], errors.map(e => ({ e })));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT_DIR, `${doc.id}.xlsx`));

  return {
    id: doc.id, krtRows: authorRows.length,
    genA: passA.generatedKrt.length, addA: passA.suggestions.filter(s => s.type === 'add_row').length,
    novelA: passA.generatedKrt.filter(g => !genInAuthor(g, authorRows, passA.decisions)).length,
    removed: removed.length,
    reDetected: removedReport.filter(r => r.reDetected === 'yes').length,
    reSuggested: removedReport.filter(r => r.reSuggested === 'yes').length,
    genC: passC ? passC.generatedKrt.length : '',
    foundC: emptyReport.filter(r => r.reDetected === 'yes').length,
    suggestedC: emptyReport.filter(r => r.reSuggested === 'yes').length,
    removedReport, emptyReport, errors: errors.length
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

// ── Rebuild from on-disk traces (no PDF, no API) ────────────────────────────
// Discover the documents whose traces exist under <out>/traces/<id>/.
function discoverTraceDocuments() {
  const base = path.join(OUT_DIR, 'traces');
  if (!fs.existsSync(base)) { console.error(`No traces dir to rebuild from: ${base}`); process.exit(1); }
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'inputs.json')))
    .map(d => d.name)
    .filter(id => !ONLY_DOCS.length || ONLY_DOCS.includes(id))
    .map(id => ({ id, key: docIdToKey(id) }));
}

// Reconstruct one document's pass results from its trace files and re-emit the
// workbook. inputs.json holds the author/modified/removed rows; each pass's
// <pass>.trace.json holds the generated KRT, decisions and suggestions.
async function rebuildDoc(doc, summaryAll) {
  const base = path.join(OUT_DIR, 'traces', doc.id);
  const readJson = (f) => { const p = path.join(base, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null; };
  const inputs = readJson('inputs.json');
  if (!inputs) { console.log(`  ! ${doc.id}: no inputs.json — skipping`); return null; }

  const passFromTrace = (name) => {
    const t = readJson(`${name}.trace.json`);
    if (!t) return null;
    return {
      generatedKrt: t.consolidation?.items || [],
      decisions: t.comparison?.decisions || [],
      suggestions: t.comparison?.suggestions || [],
      trace: t
    };
  };
  const passA = passFromTrace('original');
  if (!passA) { console.log(`  ! ${doc.id}: no original.trace.json — skipping`); return null; }
  const passB = passFromTrace('modified');
  const passC = passFromTrace('empty');

  const authorRows = inputs.authorKrt || [];
  const modifiedRows = inputs.modifiedKrt || [];
  const removed = inputs.removedForModified || [];
  const summaryRows = summaryAll.filter(s => s.key === doc.key);

  // Errors: prefer the persisted list (new traces); otherwise re-derive the
  // degraded-comparison flags from the decisions (old traces predate the field).
  let errors = inputs.errors;
  if (!Array.isArray(errors)) {
    errors = [...comparisonHealthErrors(passA.generatedKrt, passA.decisions)];
    if (passB) errors.push(...comparisonHealthErrors(passB.generatedKrt, passB.decisions));
    if (passC) errors.push(...comparisonHealthErrors(passC.generatedKrt, passC.decisions));
  }

  console.log(`  ${doc.id}: rebuilding from traces (${authorRows.length} KRT rows, ${removed.length} removed)`);
  return writeDocReport({ doc, authorRows, modifiedRows, removed, summaryRows, passA, passB, passC, errors });
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const summaryAll = parseSummary(path.join(ROOT, 'summary.csv'));
  console.log(`summary.csv: ${summaryAll.length} object rows across ${new Set(summaryAll.map(s => s.key)).size} documents`);

  let results;
  if (REBUILD) {
    // Reuse the existing run's traces to regenerate every .xlsx — no PDF, no API.
    const docs = discoverTraceDocuments();
    console.log(`Rebuilding ${docs.length} document report(s) from traces in ${OUT_DIR}\n`);
    const settled = await runPool(docs, CONCURRENCY, (doc) => logCtx.run(doc.id, async () => {
      try { return await rebuildDoc(doc, summaryAll); }
      catch (e) { console.error(`  ! ${e.message}`); return null; }
    }));
    results = settled.filter(Boolean);
    if (!results.length) { console.log('\nNothing to rebuild.'); return; }
  } else {
    const docs = discoverDocuments();
    const enabledMods = ALL_MODULES.filter(moduleEnabled);
    const effConcurrency = PLAN_ONLY ? 1 : CONCURRENCY;
    const modeLabel = MARKDOWN_ONLY ? 'MARKDOWN ONLY (pre-warm cache)' : (PLAN_ONLY ? 'PLAN ONLY' : (RANDOM_MODE ? 'random removal' : 'detectable removal'));
    console.log(`Processing ${docs.length} document(s) [mode: ${modeLabel}` +
      `${MARKDOWN_ONLY ? '' : `, modules: ${enabledMods.join(',') || 'none'}`}, concurrency: ${effConcurrency}` +
      `${(MARKDOWN_ONLY || PLAN_ONLY) ? '' : `, trace: ${TRACE ? 'on' : 'off'}`}]\n`);

    // Everything inside runs with the doc id as log context — every line this
    // document emits (script + services) is prefixed with [<pdf name>].
    const settled = await runPool(docs, effConcurrency, (doc) => logCtx.run(doc.id, async () => {
      if (!doc.key && !MARKDOWN_ONLY) console.log('  ! could not derive summary key');
      try { return await processDoc(doc, summaryAll); }
      catch (e) { console.error(`  ! ${e.message}`); return null; }
    }));
    results = settled.filter(Boolean);

    if (MARKDOWN_ONLY) { console.log(`\nDone — ${results.length} markdown file(s) cached in ${MD_DIR}`); return; }
    if (PLAN_ONLY || !results.length) { console.log('\nDone (plan).'); return; }
  }

  // Global summary workbook
  const wb = new ExcelJS.Workbook();

  // ── Overall recall, WITH and WITHOUT materials ────────────────────────────
  // Material-type rows behave very differently by pass (seeded in B, unseeded in
  // C), so they distort the headline number. Split them out for an apples-to-
  // apples read of the rest of the pipeline. (Materials group = everything that
  // isn't a dataset / software / protocol — see authorGroup.)
  const allRemoved = results.flatMap(r => r.removedReport || []);
  const allEmpty = results.flatMap(r => r.emptyReport || []);
  const isMaterial = (row) => authorGroup(row.type) === 'material';
  const aggRecall = (rows) => {
    const det = rows.filter(r => r.reDetected === 'yes').length;
    const sug = rows.filter(r => r.reSuggested === 'yes').length;
    return { target: rows.length, det, sug,
      dr: rows.length ? (det / rows.length).toFixed(2) : '', sr: rows.length ? (sug / rows.length).toFixed(2) : '' };
  };
  const overallRows = [];
  const addScope = (pass, rows) => {
    if (!rows.length) return;
    overallRows.push({ pass, scope: 'All types', ...aggRecall(rows) });
    overallRows.push({ pass, scope: 'Excluding materials', ...aggRecall(rows.filter(r => !isMaterial(r))) });
    overallRows.push({ pass, scope: 'Materials only', ...aggRecall(rows.filter(isMaterial)) });
  };
  addScope('B (partial KRT)', allRemoved);
  addScope('C (no KRT)', allEmpty);
  if (overallRows.length) {
    addSheet(wb, 'Overall recall', [
      { header: 'Pass', key: 'pass', width: 18 }, { header: 'Scope', key: 'scope', width: 20 },
      { header: 'Target', key: 'target', width: 10 }, { header: 'Re-detected', key: 'det', width: 12 },
      { header: 'Re-suggested', key: 'sug', width: 13 }, { header: 'Detect recall', key: 'dr', width: 13 },
      { header: 'Suggest recall', key: 'sr', width: 13 }
    ], overallRows);
  }

  addSheet(wb, 'Per-document', [
    { header: 'Document', key: 'id', width: 30 }, { header: 'KRT rows', key: 'krtRows', width: 10 },
    { header: 'Generated (A)', key: 'genA', width: 12 }, { header: 'Novel-in-A (over-detection)', key: 'novelA', width: 24 },
    { header: 'Add suggestions (A)', key: 'addA', width: 18 }, { header: 'Removed (B)', key: 'removed', width: 11 },
    { header: 'Re-detected (B)', key: 'reDetected', width: 14 }, { header: 'Re-suggested (B)', key: 'reSuggested', width: 15 },
    { header: 'Generated (C, no KRT)', key: 'genC', width: 18 }, { header: 'Found (C)', key: 'foundC', width: 10 },
    { header: 'Suggested (C)', key: 'suggestedC', width: 13 }, { header: 'Module errors', key: 'errors', width: 13 }
  ], results.map(r => ({ ...r })));

  // Recall by Object Type
  const byType = {};
  for (const r of allRemoved) {
    const t = r.type || '(none)';
    byType[t] = byType[t] || { type: t, removed: 0, reDetected: 0, reSuggested: 0 };
    byType[t].removed++; if (r.reDetected === 'yes') byType[t].reDetected++; if (r.reSuggested === 'yes') byType[t].reSuggested++;
  }
  const RECALL_TYPE_COLS = [
    { header: 'Object Type', key: 'type', width: 28 }, { header: 'Target', key: 'removed', width: 10 },
    { header: 'Re-detected', key: 'reDetected', width: 12 }, { header: 'Re-suggested', key: 'reSuggested', width: 12 },
    { header: 'Detect recall', key: 'dr', width: 13 }, { header: 'Suggest recall', key: 'sr', width: 13 }
  ];
  const withRecall = (rows) => rows.map(v => ({ ...v, dr: v.removed ? (v.reDetected / v.removed).toFixed(2) : '', sr: v.removed ? (v.reSuggested / v.removed).toFixed(2) : '' }));
  addSheet(wb, 'Recall by type (B, partial)', RECALL_TYPE_COLS, withRecall(Object.values(byType)));

  // No-KRT (cold start) recall by type — same aggregation over the full author
  // KRT (emptyReport). Shows what the tool finds from scratch, per type — e.g.
  // whether unseeded materials detection is worth it.
  if (allEmpty.length) {
    const byTypeC = {};
    for (const r of allEmpty) {
      const t = r.type || '(none)';
      byTypeC[t] = byTypeC[t] || { type: t, removed: 0, reDetected: 0, reSuggested: 0 };
      byTypeC[t].removed++; if (r.reDetected === 'yes') byTypeC[t].reDetected++; if (r.reSuggested === 'yes') byTypeC[t].reSuggested++;
    }
    addSheet(wb, 'Recall by type (C, no KRT)', RECALL_TYPE_COLS, withRecall(Object.values(byTypeC)));
  }

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

  console.log(`\nWrote ${results.length} document workbook(s) + _summary.xlsx to ${OUT_DIR}`);
  const pctOf = (n, d) => (d ? `${(100 * n / d).toFixed(0)}%` : '—');
  const line = (label, rows) => {
    if (!rows.length) return;
    const a = aggRecall(rows), nm = aggRecall(rows.filter(r => !isMaterial(r)));
    console.log(`${label} recall over ${a.target} rows — re-detected ${pctOf(a.det, a.target)} / re-suggested ${pctOf(a.sug, a.target)}` +
      `  |  excl. materials (${nm.target}): re-detected ${pctOf(nm.det, nm.target)} / re-suggested ${pctOf(nm.sug, nm.target)}`);
  };
  line('Partial-KRT (B)', allRemoved);
  line('No-KRT     (C)', allEmpty);
})().catch(e => { console.error(e); process.exit(1); });
