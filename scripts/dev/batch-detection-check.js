#!/usr/bin/env node

/**
 * Batch detection check — one pass per manuscript, no database writes.
 *
 * Exercises the real pipeline end to end (markdown → 5 detectors → evidence
 * grounding → dedupe → merge → KRT grounding) by calling the pure stage
 * functions directly. Nothing is persisted: no SubmissionJob, no krt_data, no
 * S3. Safe to run against a live environment.
 *
 * It reports the numbers that say whether the recent changes work:
 *   - per-module candidate counts
 *   - evidence grounding: exact / partial / dropped  (unicode folding, hallucination control)
 *   - grounding outcomes: confirmed / incomplete / not_detected
 *   - conflicts: rows where the manuscript disagrees with the author's KRT
 *   - second look: attempted / recovered / quotes rejected as unverifiable
 *
 * Usage:
 *   node scripts/dev/batch-detection-check.js                 # the default corpus
 *   node scripts/dev/batch-detection-check.js --only PD1-000580-029-org-D-4
 *   node scripts/dev/batch-detection-check.js --max-mb 8
 *
 * Markdown is cached under tmp/batch-check/markdown/ so re-runs skip the
 * (slow, external) conversion and only re-exercise the parts under test.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const ROOT = path.join(__dirname, '../..');
// The one and only demo corpus: the directory the frontend serves, and the one
// whose KRT RESOURCE TYPE values were normalised by
// scripts/patch-krt-resource-types.js. Not git-tracked (.gitignore), so treat
// edits to it as irreversible unless you take a backup first.
const DOCS = path.join(ROOT, 'src/frontend/public/demo-files');
const OUT = path.join(ROOT, 'tmp/batch-check');
const MD_CACHE = path.join(OUT, 'markdown');

const B = path.join(ROOT, 'src/backend');
const markdownClient = require(path.join(B, 'services/pdf/pdf-markdown-client.service'));
const softwareService = require(path.join(B, 'services/software/software.service'));
const softwareLm = require(path.join(B, 'services/software/software-lm.service'));
const datasetsService = require(path.join(B, 'services/datasets/datasets.service'));
const materialsService = require(path.join(B, 'services/materials/materials.service'));
const protocolsService = require(path.join(B, 'services/protocols/protocols.service'));
const identifierService = require(path.join(B, 'services/identifier-detection/identifier-detection.service'));
const identifierIndexService = require(path.join(B, 'services/identifier-detection/known-identifier-index.service'));
const { buildEvidenceIndex, attachEvidence } = require(path.join(B, 'services/pdf-analysis/evidence.service'));
const { dedupeKrtItems } = require(path.join(B, 'services/pdf-analysis/dedupe-krt-items.service'));
const { mergeDetections } = require(path.join(B, 'services/pdf-analysis/merge-detections.service'));
const { matchAuthorRows } = require(path.join(B, 'services/krt-grounding/match-author-rows.service'));
const { consolidateWithLM } = require(path.join(B, 'services/pdf-analysis/krt-generation.service'));
const { reconcileWithAuthorKrt } = require(path.join(B, 'services/pdf-analysis/pdf-analysis.service'));
const parserService = require(path.join(B, 'services/krt/parser.service'));

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ONLY = argOf('--only', null);

// `.env` holds the URL the APP CONTAINER uses. Running on the host, that name
// does not resolve and the identifier index silently drops out of the run.
if ((process.env.DATABASE_URL || '').includes('host.docker.internal')) {
  try {
    require('dns').lookupSync;
    require('child_process').execSync('getent hosts host.docker.internal', { stdio: 'ignore' });
  } catch {
    process.env.DATABASE_URL = process.env.DATABASE_URL.replace('host.docker.internal', '127.0.0.1');
  }
}
const MAX_MB = Number(argOf('--max-mb', 8));

/**
 * The corpus, covering BOTH modes the app supports.
 *
 * With an author KRT the run measures grounding (did we find the rows they
 * wrote?). Without one it measures discovery alone — the mode where nothing
 * corroborates the output, so the Generated KRT has to be read by a human.
 * Both are first-class; a corpus of only KRT-bearing papers would hide half
 * the product.
 *
 * Chosen for coverage, not for flattering results. Oversized PDFs are excluded
 * by --max-mb, not by cherry-picking.
 */
const CORPUS_WITH_KRT = [
  'JS2-020551-021-org-G-1',   // 0.4 MB — smallest
  'JH1-000478-028-org-G-1',   // 1.3 MB — xlsx KRT
  'XC1-000312-009-org-D-4',   // 1.6 MB — xlsx KRT
  'RL2-020527-020-org-G-1',   // 2.6 MB — xlsx KRT
  'JS2-020551-023-org-P-1',   // 2.8 MB — the construct-name case
  'WH1-000282-023-org-P-2',   // 3.3 MB — 335-row KRT
  'PD1-000580-029-org-D-4',   // 4.0 MB — the antibody-list case
  'MV2-020505-019-org-P-1',   // 4.8 MB — xlsx KRT
  'JJ1-000520-004-org-D-2',   // 5.4 MB — xlsx KRT
  'ML1-000592-006-org-G-1',   // 6.0 MB
  'RE2-020529-009-org-D-3',   // 6.1 MB — xlsx KRT
  'JS2-020551-015-org-O-3'    // 6.7 MB
];

/** No author KRT: pure discovery, to be reviewed by hand. */
const CORPUS_NO_KRT = [
  'AS1-000420-012-org-D-3',   // 0.7 MB
  'PV1-000458-009-org-G-1',   // 0.7 MB
  'NW1-000509-011-org-G-1',   // 1.1 MB
  'DS1-000375-012-org-P-1',   // 1.4 MB
  'GP2-000GP2-018-org-D-2',   // 1.5 MB
  'DA1-000463-013-org-D-3',   // 2.3 MB
  'GP2-000GP2-072-org-P-1',   // 2.7 MB
  'TV1-000430-004-org-P-1'    // 3.8 MB
];

const CORPUS = [...CORPUS_WITH_KRT, ...CORPUS_NO_KRT];

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

async function getMarkdown(name, pdfPath) {
  fs.mkdirSync(MD_CACHE, { recursive: true });
  const cached = path.join(MD_CACHE, `${name}.md`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf-8');

  const buffer = fs.readFileSync(pdfPath);
  // Returns the markdown STRING (not an envelope) for both the Modal and the
  // MarkItDown provider.
  const markdown = await markdownClient.convertToMarkdown(buffer, `${name}.pdf`);
  if (typeof markdown !== 'string' || !markdown) {
    throw new Error(`markdown conversion returned ${typeof markdown}`);
  }
  fs.writeFileSync(cached, markdown, 'utf-8');
  return markdown;
}

const MIME_BY_EXT = {
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

/** Author KRT rows from the shipped CSV/XLSX, in the shape the matcher expects. */
async function loadAuthorKrt(krtPath) {
  const parsed = await parserService.parseFile(
    fs.readFileSync(krtPath), MIME_BY_EXT[path.extname(krtPath).toLowerCase()], path.basename(krtPath)
  );
  const rows = Array.isArray(parsed) ? parsed : (parsed?.rows || parsed?.data || []);
  return rows.map((r, i) => ({
    id: `row-${i}`,
    resourceType: r['RESOURCE TYPE'] || r.resourceType || '',
    resourceName: r['RESOURCE NAME'] || r.resourceName || '',
    identifier: r['IDENTIFIER'] || r.identifier || '',
    source: r['SOURCE'] || r.source || '',
    newReuse: r['NEW/REUSE'] || r.newReuse || '',
    additionalInformation: r['ADDITIONAL INFORMATION'] || r.additionalInformation || ''
  })).filter((r) => r.resourceName);
}

/**
 * Run one detector, grounding its output, and report what happened.
 *
 * Also captures the quotes that FAILED to ground. A drop rate alone cannot tell
 * you whether the model hallucinated or the matcher is too strict — the quotes
 * can, so they are kept for inspection.
 */
async function runDetector(label, fn, index) {
  try {
    const raw = await fn();
    const before = new Map(raw.map((it) => [it, (it.evidence && it.evidence.quote) || '']));
    const { items, stats } = attachEvidence(raw, index, { label });

    // Every claim that did not verify, kept WITH its status so a later run can
    // be compared against this one.
    const unverified = items
      .filter((it) => it.evidence && it.evidence.verification
        && it.evidence.verification.status !== 'verified')
      .map((it) => ({
        name: it.resourceName,
        status: it.evidence.verification.status,
        identifierInText: it.evidence.verification.identifierInText,
        nameInText: it.evidence.verification.nameInText,
        claimedQuote: it.evidence.claimed ? it.evidence.claimed.quote : '',
        claimedIdentifier: it.evidence.claimed ? it.evidence.claimed.identifier : ''
      }));

    return { items: dedupeKrtItems(items, label), stats, unverified, error: null };
  } catch (error) {
    return { items: [], stats: null, unverified: [], error: error.message };
  }
}

async function processOne(name) {
  const pdfPath = path.join(DOCS, `${name}.pdf`);
  // The author KRT is OPTIONAL: "no KRT provided" is a first-class mode, not a
  // missing input. Without one, grounding reports zero author rows and every
  // candidate as unmatched, and the Generated KRT is pure discovery.
  const krtPath = ['.csv', '.xlsx']
    .map((ext) => path.join(DOCS, `${name}${ext}`))
    .find((f) => fs.existsSync(f)) || null;
  if (!fs.existsSync(pdfPath)) return { name, skipped: 'missing PDF' };
  const sizeMb = fs.statSync(pdfPath).size / 1024 / 1024;
  if (sizeMb > MAX_MB) return { name, skipped: `${sizeMb.toFixed(1)}MB > ${MAX_MB}MB` };

  const started = Date.now();
  process.stderr.write(`\n▶ ${name} (${sizeMb.toFixed(1)}MB)\n`);

  const markdown = await getMarkdown(name, pdfPath);
  const index = buildEvidenceIndex(markdown);
  const authorRows = krtPath ? await loadAuthorKrt(krtPath) : [];
  process.stderr.write(`  markdown ${markdown.length} chars · author KRT ${krtPath ? `${authorRows.length} rows` : 'NONE (discovery mode)'}\n`);

  const pdfBuffer = fs.readFileSync(pdfPath);
  // The identifier sweep reads the curated enrichment lists out of the DB.
  // Optional here: without it the other five detectors still run, and this
  // script is about the LM detectors and grounding.
  let identifierIndex = null;
  try {
    identifierIndex = await identifierIndexService.loadIndex();
  } catch (error) {
    process.stderr.write(`  (identifier index unavailable: ${error.message})\n`);
  }

  const detectors = {
    software: () => softwareService.detectSoftware(pdfBuffer, `${name}.pdf`)
      .then((r) => softwareService.applySoftwarePolicy(softwareService.buildKrtItemsSoftware(r.resources))),
    software_lm: () => (softwareLm.isEnabled()
      ? softwareLm.detectSoftwareLM(markdown).then((r) => softwareLm.buildKrtItemsSoftwareLM(r.resources))
      : Promise.resolve([])),
    datasets: () => datasetsService.detectDatasets(markdown)
      .then((r) => datasetsService.buildKrtItemsDatasets(r.resources)),
    materials: () => materialsService.detectMaterials(markdown)
      .then((r) => materialsService.buildKrtItemsMaterials(r.resources)),
    protocols: () => protocolsService.detectProtocols(markdown)
      .then((r) => protocolsService.buildKrtItemsProtocols(r.resources)),
    identifier: () => Promise.resolve(
      identifierIndex
        ? identifierService.buildKrtItemsIdentifier(
          identifierService.detectIdentifiers(markdown, identifierIndex, { cutAtReferences: false }).matches,
          markdown
        )
        : []
    )
  };

  const results = {};
  for (const [label, fn] of Object.entries(detectors)) {
    results[label] = await runDetector(label, fn, index);
    const r = results[label];
    const s = r.stats;
    process.stderr.write(
      `  ${label.padEnd(12)} ${String(r.items.length).padStart(3)} items`
      + (s ? `  (exact ${s.exact}, partial ${s.partial}, dropped ${s.dropped}/${s.total})` : '')
      + (r.error ? `  ERROR: ${r.error}` : '') + '\n'
    );
  }

  const contributions = Object.entries(results)
    .filter(([, r]) => r.items.length > 0)
    .map(([label, r]) => ({ source: label, items: r.items }));
  const candidates = mergeDetections(contributions);

  const { outcomes, stats } = matchAuthorRows(authorRows, candidates);

  // Run the REST of the pipeline so the report shows what the app would
  // actually produce, not just the candidate pool: LM consolidation drops
  // non-resources and merges near-duplicates, then reconciliation guarantees
  // every author row survives into the Generated KRT.
  const consolidated = await consolidateWithLM(candidates);
  const { items: generatedKrt, carried } = reconcileWithAuthorKrt(consolidated.items, authorRows);
  process.stderr.write(
    `  generated KRT ${generatedKrt.length} rows`
    + ` (LM ${consolidated.usedLM ? 'on' : 'off'}, dropped ${(consolidated.dropped || []).length}`
    + `, carried ${carried.length})\n`
  );
  const conflicts = outcomes.flatMap((o) => (o.conflicts || []).map((c) => ({ row: o.resourceName, ...c })));

  process.stderr.write(
    `  → candidates ${candidates.length} · confirmed ${stats.confirmed}`
    + ` · incomplete ${stats.incomplete} · partial ${stats.partial || 0}`
    + ` · not_detected ${stats.notDetected}`
    + ` · conflicts ${conflicts.length}  [${Math.round((Date.now() - started) / 1000)}s]\n`
  );

  // The full artifacts, not just counts.
  //
  // The previous run recorded `candidates: <number>`, which meant a later
  // question — "how many of those misses would the new matcher catch?" — could
  // only be answered by paying for the whole LM run again. Everything below is
  // reproducible offline: re-run matchAuthorRows over `candidatePool` and
  // `authorKrt` as often as you like, at zero cost.
  const artifacts = {
    name,
    hasAuthorKrt: Boolean(krtPath),
    krtFile: krtPath ? path.basename(krtPath) : null,
    markdownChars: markdown.length,
    grounding: stats,
    generatedKrt,
    dropped: consolidated.dropped || [],
    carriedFromAuthorKrt: carried.map((c) => c.resourceName),
    usedLM: Boolean(consolidated.usedLM),
    detections: Object.fromEntries(Object.entries(results).map(([label, r]) => [label, (r.items || []).map((it) => ({
      resourceType: it.resourceType, resourceName: it.resourceName,
      identifier: it.identifier, source: it.source, newReuse: it.newReuse,
      confidence: it.confidence, additionalInformation: it.additionalInformation,
      quote: it.evidence?.quote || '', section: it.evidence?.section || '',
      match: it.evidence?.match || null,
      status: it.evidence?.verification?.status || '',
      claimedQuote: it.evidence?.claimed?.quote || '',
      mentions: (it.evidence?.mentions || []).length
    }))])),
    authorKrt: authorRows.map((r) => ({
      id: r.id, resourceType: r.resourceType, resourceName: r.resourceName,
      identifier: r.identifier, source: r.source, newReuse: r.newReuse,
      additionalInformation: r.additionalInformation
    })),
    candidatePool: candidates,
    outcomes: outcomes.map((o) => ({
      resourceType: o.resourceType, resourceName: o.resourceName,
      outcome: o.outcome, matchedBy: o.matchedBy,
      missingFields: o.missingFields, foundValues: o.foundValues,
      conflicts: o.conflicts, reason: o.reason,
      evidenceQuote: o.evidence?.quote || ''
    }))
  };
  fs.writeFileSync(path.join(OUT, `${name}-artifacts.json`), JSON.stringify(artifacts, null, 1));

  return {
    name,
    sizeMb: Number(sizeMb.toFixed(1)),
    markdownChars: markdown.length,
    authorRows: authorRows.length,
    modules: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, {
      items: r.items.length, ...(r.stats || {}), error: r.error,
      unverified: r.unverified || []
    }])),
    hasAuthorKrt: Boolean(krtPath),
    candidates: candidates.length,
    generatedKrtRows: generatedKrt.length,
    droppedByLM: (consolidated.dropped || []).length,
    carried: carried.length,
    grounding: stats,
    conflicts,
    notDetectedRows: outcomes.filter((o) => o.outcome === 'not_detected').map((o) => `${o.resourceType}: ${o.resourceName}`),
    partialRows: outcomes.filter((o) => o.outcome === 'partial').map((o) => `${o.resourceType}: ${o.resourceName}`),
    artifactsFile: `${name}-artifacts.json`,
    durationS: Math.round((Date.now() - started) / 1000)
  };
}

async function main() {
  const names = ONLY ? [ONLY] : CORPUS;
  fs.mkdirSync(OUT, { recursive: true });

  const all = [];
  for (const name of names) {
    try {
      all.push(await processOne(name));
    } catch (error) {
      process.stderr.write(`  FAILED: ${error.message}\n`);
      all.push({ name, error: error.message });
    }
  }

  const outPath = path.join(OUT, 'results.json');
  fs.writeFileSync(outPath, JSON.stringify(all, null, 2), 'utf-8');

  // ── Aggregate report
  const done = all.filter((r) => r.grounding);
  const sum = (fn) => done.reduce((n, r) => n + fn(r), 0);
  const ev = (mod) => done.reduce((acc, r) => {
    const m = r.modules[mod] || {};
    acc.total += m.total || 0; acc.exact += m.exact || 0;
    acc.partial += m.partial || 0; acc.dropped += m.dropped || 0;
    return acc;
  }, { total: 0, exact: 0, partial: 0, dropped: 0 });

  console.log('\n' + '='.repeat(78));
  console.log('BATCH DETECTION CHECK — ' + done.length + ' manuscripts');
  console.log('='.repeat(78));

  console.log('\nEVIDENCE VERIFICATION (per LM detector)');
  console.log('  module        returned  VERBATIM  embellished  unsupported');
  for (const mod of ['datasets', 'materials', 'protocols', 'software_lm']) {
    const e = done.reduce((acc, r) => {
      const m = r.modules[mod] || {};
      acc.total += m.total || 0; acc.verified += m.verified || 0;
      acc.embellished += m.embellished || 0; acc.unsupported += m.unsupported || 0;
      return acc;
    }, { total: 0, verified: 0, embellished: 0, unsupported: 0 });
    if (e.total === 0) continue;
    console.log(`  ${mod.padEnd(13)} ${String(e.total).padStart(7)}`
      + ` ${String(e.verified).padStart(9)} (${pct(e.verified, e.total)})`
      + ` ${String(e.embellished).padStart(9)}`
      + ` ${String(e.unsupported).padStart(11)}`);
  }

  const rows = sum((r) => r.grounding.authorRows);
  console.log('\nKRT GROUNDING (author rows vs the manuscript)');
  console.log(`  author rows      ${rows}`);
  console.log(`  confirmed        ${sum((r) => r.grounding.confirmed)}  (${pct(sum((r) => r.grounding.confirmed), rows)})`);
  console.log(`  incomplete       ${sum((r) => r.grounding.incomplete)}`);
  console.log(`  not detected     ${sum((r) => r.grounding.notDetected)}  (${pct(sum((r) => r.grounding.notDetected), rows)})`);
  console.log(`  conflicts found  ${sum((r) => r.conflicts.length)}`);

  console.log('\nPER MANUSCRIPT');
  for (const r of all) {
    if (r.skipped) { console.log(`  ${r.name.padEnd(24)} SKIPPED (${r.skipped})`); continue; }
    if (!r.grounding) { console.log(`  ${r.name.padEnd(24)} FAILED (${r.error})`); continue; }
    console.log(`  ${r.name.padEnd(24)} rows ${String(r.authorRows).padStart(3)}`
      + ` · cand ${String(r.candidates).padStart(3)}`
      + ` · ok ${String(r.grounding.confirmed).padStart(3)}`
      + ` · miss ${String(r.grounding.notDetected).padStart(3)}`
      + ` · conflict ${String(r.conflicts.length).padStart(2)}`
      + ` · ${r.durationS}s`);
  }

  const allConflicts = all.flatMap((r) => r.conflicts || []);
  if (allConflicts.length) {
    console.log('\nCONFLICTS (manuscript disagrees with the author KRT)');
    for (const c of allConflicts.slice(0, 15)) {
      console.log(`  ${c.row}\n    ${c.field}: KRT "${c.authorValue}"  ≠  paper "${c.manuscriptValue}"`);
    }
  }

  console.log(`\nFull results: ${path.relative(ROOT, outPath)}\n`);

  // The identifier index opens a Sequelize pool, which keeps the event loop
  // alive forever — a finished run then sat in an undead container for hours.
  try {
    const { sequelize } = require(path.join(B, 'models'));
    await sequelize.close();
  } catch { /* models never loaded — nothing to close */ }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
