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
 *   --random          pass B removes a random subset of ANY line (not just detectable)
 *   --remove-frac F   fraction of eligible lines to remove in pass B (default 0.3, min 1 line)
 *   --seed N          RNG seed for deterministic removal (default 42)
 *   --skip-modified   only run pass A
 *   --plan            offline: discover + parse + show the removal plan, NO pipeline/API calls
 *   --help
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
const REMOVE_FRAC = Math.max(0, Math.min(1, parseFloat(getArg('--remove-frac', '0.3')) || 0.3));
const SKIP_MODIFIED = has('--skip-modified');
const PLAN_ONLY = has('--plan');
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
    optional: bool(r['Object is Optional'])
  })).filter(r => r.key && r.name);
}

// ── ID mapping: documents and summary use different id schemes ──────────────
// doc:     CS1-000301-014-org-G-1        → key 000301|14|G
//          GP2-000GP2-017-org-G-1        → key 000GP2|17|G
// summary: ASAP-000301-014-0000CS-G-DS1  → key 000301|14|G
//          ASAP-000GP2-0017-G            → key 000GP2|17|G
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

// ── Matching: is a line present in a set of KRT-ish items? ──────────────────
function lineMatches(a, b) {
  if (a.identifier && b.identifier && identifiersMatch(a.identifier, b.identifier)) return true;
  const na = normalizeName(a.resourceName), nb = normalizeName(b.resourceName);
  return !!na && na === nb;
}
const presentIn = (line, items) => (items || []).some(it => lineMatches(line, it));

// ── Detection (seed-independent: software + identifier — same for both passes) ──
let _idxLoaded = null;
async function loadIdIndex() {
  if (_idxLoaded) return _idxLoaded;
  if (!fs.existsSync(IDENTIFIERS_DIR)) return null;
  _idxLoaded = await knownIdentifierIndex.loadIndex({ provider: createCsvProvider(IDENTIFIERS_DIR) });
  return _idxLoaded;
}

async function safe(label, fn, errors) {
  try { return await fn(); }
  catch (e) { errors.push(`${label}: ${e.message}`); return []; }
}

async function detectSeedIndependent(pdfBuffer, markdown, fileName, errors) {
  const software = await safe('software', async () => {
    const { resources } = await softwareService.detectSoftware(pdfBuffer, fileName);
    return dedupeKrtItems(softwareService.applySoftwarePolicy(softwareService.buildKrtItemsSoftware(resources)), 'software');
  }, errors);
  const identifier = await safe('identifier', async () => {
    const index = await loadIdIndex();
    if (!index) return [];
    const { matches } = identifierService.detectIdentifiers(markdown, index);
    const krt = identifierService.buildKrtItemsIdentifier(matches, markdown);
    return dedupeKrtItems(identifierService.enrichIdentifiers(krt).enriched, 'identifier');
  }, errors);
  return { software, identifier };
}

/** One full pass: seed-dependent detectors + merge + LM consolidation + LM comparison. */
async function runPass(pdfBuffer, markdown, fileName, authorRows, seedIndependent, errors) {
  const byGroup = (g) => authorRows.filter(r => authorGroup(r.resourceType) === g);
  const datasetSeeds = datasetsService.buildAuthorDatasetSeeds(byGroup('dataset'));
  const protocolSeeds = buildAuthorSeeds(byGroup('protocol'));
  const materialSeeds = buildAuthorSeeds(byGroup('material'));

  const datasets = await safe('datasets', async () => {
    const { resources } = await datasetsService.detectDatasets(markdown, { authorDatasets: datasetSeeds });
    return dedupeKrtItems(datasetsService.buildKrtItemsDatasets(resources), 'datasets');
  }, errors);
  const protocols = await safe('protocols', async () => {
    const { resources } = await protocolsService.detectProtocols(markdown, { authorProtocols: protocolSeeds });
    return dedupeKrtItems(protocolsService.buildKrtItemsProtocols(resources), 'protocols');
  }, errors);
  // Materials is author-seeded only — skipped when the author listed none (same as the app).
  const materials = materialSeeds.length === 0 ? [] : await safe('materials', async () => {
    const { resources } = await materialsService.detectMaterials(pdfBuffer, fileName, { authorMaterials: materialSeeds });
    return dedupeKrtItems(materialsService.buildKrtItemsMaterials(resources), 'materials');
  }, errors);

  const contributions = [
    { source: 'software_detection', items: seedIndependent.software },
    { source: 'identifier_detection', items: seedIndependent.identifier },
    { source: 'datasets_detection', items: datasets },
    { source: 'protocols_detection', items: protocols },
    { source: 'materials_detection', items: materials }
  ].filter(c => c.items && c.items.length);

  const candidates = mergeDetections(contributions);
  let generatedKrt = candidates;
  try { generatedKrt = (await consolidateWithLM(candidates)).items || candidates; }
  catch (e) { errors.push(`krt-generation: ${e.message}`); }

  let suggestions = [], decisions = [];
  await safe('comparison', async () => {
    const res = await compareKrts(authorRows, generatedKrt);
    suggestions = res.suggestions; decisions = res.decisions;
    return [];
  }, errors);

  return { generatedKrt, suggestions, decisions };
}

// ── Removal selection for pass B ────────────────────────────────────────────
/** Choose which author lines to remove, returning the removed rows (with their summary flags). */
function chooseRemovals(authorRows, summaryRows) {
  const summaryFor = (row) => {
    const nn = normalizeName(row.resourceName);
    return summaryRows.find(s => normalizeName(s.name) === nn)
        || summaryRows.find(s => nn && normalizeName(s.name).includes(nn) || (nn && nn.includes(normalizeName(s.name)))) || null;
  };
  const annotated = authorRows.map(r => ({ row: r, summary: summaryFor(r) }));
  let eligible;
  if (RANDOM_MODE) {
    eligible = annotated;
  } else {
    // "clearly detectable": shared in text or supplemental, and not optional.
    eligible = annotated.filter(a => a.summary && (a.summary.sharedText || a.summary.sharedSupp) && !a.summary.optional);
  }
  const shuffled = [...eligible].sort(() => rand() - 0.5);
  const n = Math.max(eligible.length ? 1 : 0, Math.round(eligible.length * REMOVE_FRAC));
  return shuffled.slice(0, n);
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

function generatedRows(generatedKrt, authorRows) {
  return generatedKrt.map((g, i) => ({
    '#': i + 1, type: g.resourceType, name: g.resourceName, source: g.sourceUrl || '',
    identifier: g.identifier || '', newReuse: g.newReuse || '', modules: modulesOf(g),
    inAuthorKrt: presentIn(g, authorRows) ? 'yes' : 'NO (novel)', reason: g.reason || ''
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

// ── Per-document run ────────────────────────────────────────────────────────
async function processDoc(doc, summaryAll) {
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
  const markdown = await safe('markdown', async () => await convertToMarkdown(pdfBuffer, path.basename(doc.pdf)), errors);
  if (!markdown || !String(markdown).trim()) { console.log(`  ! ${doc.id}: markdown conversion failed — skipping (${errors.join('; ')})`); return null; }
  const seedIndependent = await detectSeedIndependent(pdfBuffer, markdown, path.basename(doc.pdf), errors);

  const passA = await runPass(pdfBuffer, markdown, path.basename(doc.pdf), authorRows, seedIndependent, errors);
  const passB = SKIP_MODIFIED ? null : await runPass(pdfBuffer, markdown, path.basename(doc.pdf), modifiedRows, seedIndependent, errors);

  // Build per-document workbook
  const wb = new ExcelJS.Workbook();
  addSheet(wb, 'A - Generated KRT', GEN_COLS, generatedRows(passA.generatedKrt, authorRows));
  addSheet(wb, 'A - Suggestions', SUG_COLS, decisionRows(passA.decisions));

  let removedReport = [];
  if (passB) {
    addSheet(wb, 'B - Generated KRT', GEN_COLS, generatedRows(passB.generatedKrt, modifiedRows));
    addSheet(wb, 'B - Suggestions', SUG_COLS, decisionRows(passB.decisions));
    const addSugs = passB.suggestions.filter(s => s.type === 'add_row');
    removedReport = removed.map(r => {
      const reDetected = presentIn(r.row, passB.generatedKrt);
      const reSuggested = addSugs.some(s => lineMatches(r.row, { resourceName: s.data?.resourceName, identifier: s.data?.identifier }));
      return {
        type: r.row.resourceType, name: r.row.resourceName, identifier: r.row.identifier,
        sharedKrt: r.summary?.sharedKrt ?? '', sharedText: r.summary?.sharedText ?? '', sharedSupp: r.summary?.sharedSupp ?? '',
        optional: r.summary?.optional ?? '', reDetected: reDetected ? 'yes' : 'NO', reSuggested: reSuggested ? 'yes' : 'NO'
      };
    });
    addSheet(wb, 'B - Removed lines (recall)', [
      { header: 'Resource Type', key: 'type', width: 24 }, { header: 'Resource Name', key: 'name', width: 40 },
      { header: 'Identifier', key: 'identifier', width: 24 }, { header: 'Shared KRT', key: 'sharedKrt', width: 10 },
      { header: 'Shared Text', key: 'sharedText', width: 10 }, { header: 'Shared Supp', key: 'sharedSupp', width: 10 },
      { header: 'Optional', key: 'optional', width: 9 }, { header: 'Re-detected (Generated KRT)', key: 'reDetected', width: 22 },
      { header: 'Re-suggested (add)', key: 'reSuggested', width: 18 }
    ], removedReport);
  }
  if (errors.length) addSheet(wb, 'Errors', [{ header: 'Module error', key: 'e', width: 100 }], errors.map(e => ({ e })));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT_DIR, `${doc.id}.xlsx`));

  return {
    id: doc.id, krtRows: authorRows.length,
    genA: passA.generatedKrt.length, addA: passA.suggestions.filter(s => s.type === 'add_row').length,
    novelA: passA.generatedKrt.filter(g => !presentIn(g, authorRows)).length,
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
    if (!krtFile) { console.log(`  - ${id}: no KRT file — skipping`); continue; }
    const key = docIdToKey(id);
    docs.push({ id, pdf: path.join(DOC_DIR, pdf), krtFile, key });
  }
  return docs;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const summaryAll = parseSummary(path.join(ROOT, 'summary.csv'));
  console.log(`summary.csv: ${summaryAll.length} object rows across ${new Set(summaryAll.map(s => s.key)).size} documents`);
  const docs = discoverDocuments();
  console.log(`Processing ${docs.length} document(s) [mode: ${RANDOM_MODE ? 'random removal' : 'detectable removal'}${PLAN_ONLY ? ', PLAN ONLY' : ''}]\n`);

  const results = [];
  for (const doc of docs) {
    if (!doc.key) console.log(`  ! ${doc.id}: could not derive summary key`);
    try { const r = await processDoc(doc, summaryAll); if (r) results.push(r); }
    catch (e) { console.error(`  ! ${doc.id}: ${e.message}`); }
  }

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

  fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(path.join(OUT_DIR, '_summary.xlsx'));

  const totRemoved = allRemoved.length, totDet = allRemoved.filter(r => r.reDetected === 'yes').length, totSug = allRemoved.filter(r => r.reSuggested === 'yes').length;
  console.log(`\nWrote ${results.length} document workbook(s) + _summary.xlsx to ${OUT_DIR}`);
  if (totRemoved) console.log(`Recall over ${totRemoved} removed lines — re-detected: ${totDet} (${(100 * totDet / totRemoved).toFixed(0)}%), re-suggested: ${totSug} (${(100 * totSug / totRemoved).toFixed(0)}%)`);
})().catch(e => { console.error(e); process.exit(1); });
