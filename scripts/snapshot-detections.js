#!/usr/bin/env node

/**
 * Snapshot Detection Outputs
 *
 * Runs each detection module's four-step pipeline (detect → buildKrtItems →
 * enrich → dedupe) against the demo manuscripts and writes the resulting
 * canonical KrtEntry[] as JSON fixtures. Used as the regression net for the
 * pipeline refactor: take one snapshot before, one after a change, diff with
 * `--diff <before> <after>`.
 *
 * Output: tmp/detection-snapshots/<phase>/<manuscriptId>/<detector>.json
 * Each file is { manuscriptId, detector, itemsCount, items } — items sorted
 * deterministically by (resourceType, resourceName, identifier) so the diff
 * isn't polluted by ordering noise.
 *
 * Usage:
 *   node scripts/snapshot-detections.js --phase <label> [options]
 *
 * Options:
 *   --phase LABEL         Output dir name under tmp/detection-snapshots/ (required)
 *   --manuscript ID       Run only this manuscript (case-insensitive)
 *   --type t1,t2          Only run these types
 *                         (protocols, datasets, software, materials, identifiers)
 *   --skip t1,t2          Skip these types
 *   --concurrency N       Max parallel manuscripts (default: 3)
 *   --diff A B            Diff two existing snapshots and print a per-detector summary
 *   --help                Show this help
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DEMO_FINDINGS_DIR = path.join(__dirname, '../src/backend/data/demo-findings');
const DEMO_PDF_DIR      = path.join(__dirname, '../src/frontend/public/demo-files');
const IDENTIFIERS_DIR   = path.join(__dirname, '../tmp/identifiers');
const SNAPSHOTS_ROOT    = path.join(__dirname, '../tmp/detection-snapshots');

// Pipeline imports
const { sortKrtItems } = require('../src/backend/services/pdf-analysis/krt-entry');
const { dedupeKrtItems } = require('../src/backend/services/pdf-analysis/dedupe-krt-items.service');
const { createCsvProvider } = require('../src/backend/services/enrichment-list-providers');
const protocolsService = require('../src/backend/services/protocols/protocols.service');
const datasetsService  = require('../src/backend/services/datasets/datasets.service');
const softwareService  = require('../src/backend/services/software/software.service');
const materialsService = require('../src/backend/services/materials/materials.service');
const identifierService = require('../src/backend/services/identifier-detection/identifier-detection.service');
const knownIdentifierIndex = require('../src/backend/services/identifier-detection/known-identifier-index.service');

const csvProvider = createCsvProvider(IDENTIFIERS_DIR);

// ===================== CLI =====================

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf-8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] || '');
  process.exit(0);
}

function getArg(name, defaultValue) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

function getArgMulti(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const collected = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    collected.push(args[i]);
  }
  return collected;
}

const PHASE = getArg('--phase', null);
const MANUSCRIPT_FILTER = getArg('--manuscript', null);
const TYPE_FILTER = getArg('--type', null)?.split(',') || null;
const SKIP_TYPES = getArg('--skip', null)?.split(',') || [];
const CONCURRENCY = parseInt(getArg('--concurrency', '3'), 10);
const DIFF_PAIR = getArgMulti('--diff');

function isTypeEnabled(type) {
  if (SKIP_TYPES.includes(type)) return false;
  if (TYPE_FILTER && !TYPE_FILTER.includes(type)) return false;
  return true;
}

if (DIFF_PAIR && DIFF_PAIR.length === 2) {
  diffSnapshots(DIFF_PAIR[0], DIFF_PAIR[1]);
  process.exit(0);
}

if (!PHASE) {
  console.error('Error: --phase LABEL is required (or use --diff A B). Run with --help for details.');
  process.exit(1);
}

// ===================== DISCOVERY =====================

function discoverManuscripts() {
  if (!fs.existsSync(DEMO_FINDINGS_DIR)) {
    throw new Error(`Demo findings dir not found: ${DEMO_FINDINGS_DIR}`);
  }
  const jsonFiles = fs.readdirSync(DEMO_FINDINGS_DIR).filter(f => f.endsWith('-demo.json'));
  const manuscripts = [];
  for (const jsonFile of jsonFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(DEMO_FINDINGS_DIR, jsonFile), 'utf-8'));
    const msId = data.manuscriptId;
    if (!msId) continue;
    if (MANUSCRIPT_FILTER && msId.toUpperCase() !== MANUSCRIPT_FILTER.toUpperCase()) continue;
    const slug = jsonFile.replace('-demo.json', '');
    const mdPath = path.join(DEMO_FINDINGS_DIR, `${slug}-demo.md`);
    const pdfPath = path.join(DEMO_PDF_DIR, `${msId}.pdf`);
    manuscripts.push({
      manuscriptId: msId,
      mdPath: fs.existsSync(mdPath) ? mdPath : null,
      pdfPath: fs.existsSync(pdfPath) ? pdfPath : null
    });
  }
  return manuscripts.sort((a, b) => a.manuscriptId.localeCompare(b.manuscriptId));
}

// ===================== SERVICE AVAILABILITY =====================

function checkServiceAvailability() {
  const status = {};
  const tryConfig = (key, configPath, promptPath = null) => {
    try {
      const cfg = require(configPath);
      const promptOK = !promptPath || fs.existsSync(promptPath);
      const ok = cfg.isConfigured() && promptOK;
      status[key] = {
        available: ok,
        reason: ok ? 'OK' : (!cfg.isConfigured() ? 'Not configured' : 'Prompt file missing')
      };
    } catch {
      status[key] = { available: false, reason: 'Config not found' };
    }
  };
  const PROMPTS = path.join(__dirname, '../src/backend/data/prompts');
  tryConfig('protocols', '../src/backend/config/protocols-detection-api', path.join(PROMPTS, 'protocols-detection.txt'));
  tryConfig('datasets',  '../src/backend/config/datasets-detection-api',  path.join(PROMPTS, 'datasets-consolidation.txt'));
  tryConfig('materials', '../src/backend/config/materials-detection-api', path.join(PROMPTS, 'materials-detection.txt'));
  tryConfig('software',  '../src/backend/config/softcite-api');

  const requiredCsvs = ['software', 'materials', 'datasets', 'protocols']
    .map(c => path.join(IDENTIFIERS_DIR, `curated-${c}.csv`));
  const missing = requiredCsvs.filter(p => !fs.existsSync(p));
  status.identifiers = missing.length === 0
    ? { available: true, reason: 'OK (curated CSVs present)' }
    : { available: false, reason: `Missing ${missing.length} curated CSV(s) under tmp/identifiers` };
  return status;
}

// ===================== PIPELINE RUNNERS =====================

async function runProtocols(markdownText) {
  const { resources } = await protocolsService.detectProtocols(markdownText);
  const krt = protocolsService.buildKrtItemsProtocols(resources);
  return dedupeKrtItems(krt, 'protocols-gemini');
}

async function runDatasets(markdownText) {
  const { resources } = await datasetsService.detectDatasets(markdownText);
  const krt = datasetsService.buildKrtItemsDatasets(resources);
  return dedupeKrtItems(krt, 'datasets-gemini');
}

async function runSoftware(pdfBuffer, fileName) {
  const { resources } = await softwareService.detectSoftware(pdfBuffer, fileName);
  const krt = softwareService.buildKrtItemsSoftware(resources);
  return dedupeKrtItems(krt, 'software-softcite');
}

async function runMaterials(pdfBuffer, fileName) {
  const { resources } = await materialsService.detectMaterials(pdfBuffer, fileName);
  const krt = materialsService.buildKrtItemsMaterials(resources);
  return dedupeKrtItems(krt, 'materials-gemini');
}

let _indexBuilt = false;
async function ensureIdentifierIndex() {
  if (_indexBuilt) return;
  await knownIdentifierIndex.loadIndex({ provider: csvProvider });
  _indexBuilt = true;
}
async function runIdentifiers(markdownText) {
  await ensureIdentifierIndex();
  const index = await knownIdentifierIndex.loadIndex({ provider: csvProvider });
  const { matches } = identifierService.detectIdentifiers(markdownText, index);
  const krt = identifierService.buildKrtItemsIdentifier(matches, markdownText);
  const { enriched } = identifierService.enrichIdentifiers(krt);
  return dedupeKrtItems(enriched, 'identifier-scan');
}

// ===================== SNAPSHOT WRITER =====================

function snapshotPath(phase, manuscriptId, detector) {
  return path.join(SNAPSHOTS_ROOT, phase, manuscriptId, `${detector}.json`);
}

function writeSnapshot(phase, manuscriptId, detector, items) {
  const file = snapshotPath(phase, manuscriptId, detector);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    manuscriptId,
    detector,
    phase,
    itemsCount: Array.isArray(items) ? items.length : 0,
    items: sortKrtItems(items)
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

// ===================== POOL =====================

async function runPool(tasks, concurrency) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  return Promise.all(results);
}

// ===================== PER-MANUSCRIPT =====================

async function processManuscript(ms, serviceStatus) {
  const ctx = { manuscriptId: ms.manuscriptId, errors: [] };
  const markdownText = ms.mdPath ? fs.readFileSync(ms.mdPath, 'utf-8') : null;
  const pdfBuffer = ms.pdfPath ? fs.readFileSync(ms.pdfPath) : null;
  const fileName = `${ms.manuscriptId}.pdf`;

  const runs = [
    ['protocols',   () => markdownText && runProtocols(markdownText)],
    ['datasets',    () => markdownText && runDatasets(markdownText)],
    ['software',    () => pdfBuffer    && runSoftware(pdfBuffer, fileName)],
    ['materials',   () => pdfBuffer    && runMaterials(pdfBuffer, fileName)],
    ['identifiers', () => markdownText && runIdentifiers(markdownText)]
  ];

  for (const [type, fn] of runs) {
    if (!isTypeEnabled(type)) continue;
    if (!serviceStatus[type]?.available) continue;
    try {
      console.log(`  [${ms.manuscriptId}] ${type}…`);
      const items = await fn();
      writeSnapshot(PHASE, ms.manuscriptId, type, items || []);
    } catch (err) {
      ctx.errors.push(`${type}: ${err.message}`);
      console.error(`  [${ms.manuscriptId}] ${type} ERROR: ${err.message}`);
    }
  }
  return ctx;
}

// ===================== DIFF =====================

function diffSnapshots(beforeLabel, afterLabel) {
  const beforeDir = path.join(SNAPSHOTS_ROOT, beforeLabel);
  const afterDir  = path.join(SNAPSHOTS_ROOT, afterLabel);
  if (!fs.existsSync(beforeDir)) { console.error(`No snapshot: ${beforeDir}`); process.exit(1); }
  if (!fs.existsSync(afterDir))  { console.error(`No snapshot: ${afterDir}`);  process.exit(1); }

  const collect = (root) => {
    const out = new Map();
    for (const ms of fs.readdirSync(root)) {
      const msDir = path.join(root, ms);
      if (!fs.statSync(msDir).isDirectory()) continue;
      for (const f of fs.readdirSync(msDir)) {
        if (!f.endsWith('.json')) continue;
        const detector = f.replace(/\.json$/, '');
        out.set(`${ms}::${detector}`, JSON.parse(fs.readFileSync(path.join(msDir, f), 'utf-8')));
      }
    }
    return out;
  };

  const before = collect(beforeDir);
  const after  = collect(afterDir);
  const keys = new Set([...before.keys(), ...after.keys()]);

  const byDetector = new Map();
  for (const key of [...keys].sort()) {
    const detector = key.split('::')[1];
    const b = before.get(key);
    const a = after.get(key);
    const bn = b?.itemsCount ?? 0;
    const an = a?.itemsCount ?? 0;
    const slot = byDetector.get(detector) || { before: 0, after: 0, manuscripts: 0, deltaNonZero: 0 };
    slot.before += bn;
    slot.after  += an;
    slot.manuscripts += 1;
    if (bn !== an) slot.deltaNonZero += 1;
    byDetector.set(detector, slot);
  }

  console.log(`\n=== Snapshot diff: ${beforeLabel} → ${afterLabel} ===\n`);
  console.log('detector       manuscripts   before    after     Δ-count   manuscripts-changed');
  console.log('-------------- ------------- --------- --------- --------- -------------------');
  for (const [det, s] of [...byDetector.entries()].sort()) {
    const delta = s.after - s.before;
    const sign = delta > 0 ? '+' : '';
    console.log(
      `${det.padEnd(14)} ${String(s.manuscripts).padStart(13)} ${String(s.before).padStart(9)} ${String(s.after).padStart(9)} ${(sign + delta).padStart(9)} ${String(s.deltaNonZero).padStart(19)}`
    );
  }
  console.log(`\nUse \`git diff --no-index ${beforeDir} ${afterDir}\` for full per-item diffs.\n`);
}

// ===================== MAIN =====================

async function main() {
  console.log('=== Snapshot Detection Outputs ===');
  console.log(`Phase: ${PHASE}`);
  console.log(`Output: ${path.join(SNAPSHOTS_ROOT, PHASE)}\n`);

  const manuscripts = discoverManuscripts();
  if (manuscripts.length === 0) {
    console.error('No manuscripts matched the filters.');
    process.exit(1);
  }
  console.log(`Manuscripts: ${manuscripts.length}`);

  const serviceStatus = checkServiceAvailability();
  console.log('\nService availability:');
  for (const [type, st] of Object.entries(serviceStatus)) {
    const enabled = isTypeEnabled(type);
    const icon = !enabled ? '⊘' : st.available ? '✓' : '✗';
    console.log(`  ${icon} ${type}: ${enabled ? st.reason : 'skipped by --type/--skip'}`);
  }

  console.log(`\nConcurrency: ${CONCURRENCY}\n`);

  const tasks = manuscripts.map(ms => () => {
    console.log(`▸ ${ms.manuscriptId}`);
    return processManuscript(ms, serviceStatus);
  });
  const results = await runPool(tasks, CONCURRENCY);

  const errorCount = results.reduce((n, r) => n + (r.errors.length > 0 ? 1 : 0), 0);
  console.log(`\nDone. ${results.length} manuscripts, ${errorCount} with errors.`);
  console.log(`Snapshot dir: ${path.join(SNAPSHOTS_ROOT, PHASE)}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
