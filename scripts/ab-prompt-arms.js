#!/usr/bin/env node
/**
 * A/B/C over PROMPTS, with the pipeline held constant.
 *
 * The engine is this branch in every arm — same evidence verification, same
 * merge, same consolidation, same matcher. Only the detection prompts and the
 * seeding change. That is what makes the result attributable: everything else
 * is identical by construction, because it is the same code running three
 * times.
 *
 *   A  branch prompts, no seed              the current design
 *   B  dev prompts + the FULL author KRT    dev's design, on this engine
 *   C  dev prompts + the author KRT FILTERED to rows whose name or identifier
 *      actually occurs in the manuscript    does seed QUALITY matter?
 *
 * A vs B  — does splitting detection from grounding help or hurt?
 * B vs C  — is the echo caused by unverifiable seeds, and does filtering fix it?
 *
 * Arms are run INTERLEAVED per document (A,B,C on doc 1, then doc 2...), so each
 * document contributes a matched triple minutes apart. Run-to-run variance is
 * large enough here — the same document returned 16 materials once and 5 the
 * next time — that a cross-session baseline would sit inside the comparison.
 *
 * Two measures that seeding CANNOT inflate:
 *   discovery  items found that are NOT author rows
 *   echo       author rows the detector "found" whose evidence does not verify
 *
 * Usage: node scripts/ab-prompt-arms.js [--only <name>] [--arms A,B,C]
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ROOT = path.join(__dirname, '..');
const B = path.join(ROOT, 'src/backend');
const DOCS = path.join(ROOT, 'src/frontend/public/demo-files');
const MD_CACHE = path.join(ROOT, 'tmp/batch-check/markdown');
const VARIANTS = path.join(ROOT, 'tmp/prompt-variants/dev');
const OUT = path.join(ROOT, 'tmp/ab-arms');

const datasetsService = require(path.join(B, 'services/datasets/datasets.service'));
const materialsService = require(path.join(B, 'services/materials/materials.service'));
const protocolsService = require(path.join(B, 'services/protocols/protocols.service'));
const softwareService = require(path.join(B, 'services/software/software.service'));
const softwareLm = require(path.join(B, 'services/software/software-lm.service'));
const identifierService = require(path.join(B, 'services/identifier-detection/identifier-detection.service'));
const identifierIndexService = require(path.join(B, 'services/identifier-detection/known-identifier-index.service'));
const { buildEvidenceIndex, attachEvidence, findAllOccurrences } =
  require(path.join(B, 'services/pdf-analysis/evidence.service'));
const { dedupeKrtItems } = require(path.join(B, 'services/pdf-analysis/dedupe-krt-items.service'));
const { mergeDetections } = require(path.join(B, 'services/pdf-analysis/merge-detections.service'));
const { consolidateWithLM } = require(path.join(B, 'services/pdf-analysis/krt-generation.service'));
const { reconcileWithAuthorKrt } = require(path.join(B, 'services/pdf-analysis/pdf-analysis.service'));
const { matchAuthorRows } = require(path.join(B, 'services/krt-grounding/match-author-rows.service'));
const { buildAuthorSeeds } = require(path.join(B, 'services/krt/author-krt-seeds.service'));
const { getResourceTypeGroupOrder } = require(path.join(B, 'config/constants'));
const parserService = require(path.join(B, 'services/krt/parser.service'));

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = argOf('--only', null);
const ARMS = argOf('--arms', 'A,B,C').split(',').map((s) => s.trim().toUpperCase());

const CORPUS = ONLY ? [ONLY] : [
  'JS2-020551-021-org-G-1', 'JH1-000478-028-org-G-1', 'RL2-020527-020-org-G-1',
  'JS2-020551-023-org-P-1', 'WH1-000282-023-org-P-2', 'PD1-000580-029-org-D-4',
  'MV2-020505-019-org-P-1', 'JJ1-000520-004-org-D-2', 'ML1-000592-006-org-G-1',
  'RE2-020529-009-org-D-3', 'JS2-020551-015-org-O-3'
];

const GROUP = { dataset: 0, software: 1, protocol: 2, material: 3 };
const MIME = { '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const devPrompt = (n) => fs.readFileSync(path.join(VARIANTS, `${n}.txt`), 'utf-8');
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

async function loadAuthorKrt(p) {
  const parsed = await parserService.parseFile(fs.readFileSync(p), MIME[path.extname(p).toLowerCase()], path.basename(p));
  const rows = Array.isArray(parsed) ? parsed : (parsed?.rows || parsed?.data || []);
  return rows.map((r, i) => ({
    id: `row-${i}`,
    resourceType: r['RESOURCE TYPE'] || '', resourceName: r['RESOURCE NAME'] || '',
    identifier: r['IDENTIFIER'] || '', source: r['SOURCE'] || '',
    newReuse: r['NEW/REUSE'] || '', additionalInformation: r['ADDITIONAL INFORMATION'] || ''
  })).filter((r) => r.resourceName);
}

/** Is this author row's name or identifier literally in the manuscript? */
function rowInText(index, row) {
  const id = String(row.identifier || '').replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim();
  if (id.length >= 4 && findAllOccurrences(index, id, 1).length > 0) return true;
  return String(row.resourceName || '').trim().length >= 4
    && findAllOccurrences(index, row.resourceName, 1).length > 0;
}

async function runDetector(label, fn, index) {
  try {
    const { items, stats } = attachEvidence(await fn(), index, { label });
    return { label, items: dedupeKrtItems(items, label), stats, error: null };
  } catch (e) {
    return { label, items: [], stats: null, error: e.message };
  }
}

/**
 * One arm over one document.
 * @param {'A'|'B'|'C'} arm
 * @param {object[]} seeds - author rows used for seeding ([] for arm A)
 */
async function runArm(arm, { name, markdown, index, authorRows, seeds, groupOrder, pdfPath, idIndex }) {
  const seedFor = (group) => buildAuthorSeeds(seeds.filter((r) => groupOrder[r.resourceType] === group));
  // dev appends seeds as a labelled block AFTER the prompt and BEFORE the
  // article; this engine appends the article the same way, so prompt+block
  // reproduces dev's structure exactly.
  const block = (title, rows) => (rows.length ? `\n\n---\n\n${title}\n\n${JSON.stringify(rows, null, 2)}` : '');
  const useDev = arm !== 'A';

  const matPrompt = useDev ? devPrompt('materials-detection') + block('AUTHOR-PROVIDED MATERIALS (KRT):', seedFor(GROUP.material)) : undefined;
  const proPrompt = useDev ? devPrompt('protocols-detection') + block('AUTHOR-PROVIDED PROTOCOLS (KRT):', seedFor(GROUP.protocol)) : undefined;
  // datasets: dev puts seeds in a JSON payload FIELD its prompt references by
  // name. This engine's payload has no such field, so the block is labelled to
  // match — same information, different placement. Recorded as a deviation.
  const dsPrompt = useDev ? devPrompt('datasets-consolidation') + block('author_provided_datasets:', seedFor(GROUP.dataset)) : undefined;
  const dsSignals = useDev ? devPrompt('datasets-signals-extraction') : undefined;

  const results = [];
  results.push(await runDetector('software', async () => {
    const d = await softwareService.detectSoftware(fs.readFileSync(pdfPath), `${name}.pdf`);
    return softwareService.applySoftwarePolicy(softwareService.buildKrtItemsSoftware(d?.resources || []));
  }, index));
  results.push(await runDetector('software_lm', async () => (softwareLm.isEnabled()
    ? softwareLm.detectSoftwareLM(markdown).then((r) => softwareLm.buildKrtItemsSoftwareLM(r.resources))
    : []), index));
  results.push(await runDetector('datasets', async () => {
    const d = await datasetsService.detectDatasets(markdown, { prompt: dsPrompt, signalsPrompt: dsSignals });
    return datasetsService.buildKrtItemsDatasets(d.resources || []);
  }, index));
  results.push(await runDetector('materials', async () => {
    const d = await materialsService.detectMaterials(markdown, { prompt: matPrompt });
    return materialsService.buildKrtItemsMaterials(d.resources || []);
  }, index));
  results.push(await runDetector('protocols', async () => {
    const d = await protocolsService.detectProtocols(markdown, { prompt: proPrompt });
    return protocolsService.buildKrtItemsProtocols(d.resources || []);
  }, index));
  results.push(await runDetector('identifier', async () => (idIndex
    ? identifierService.buildKrtItemsIdentifier(
      identifierService.detectIdentifiers(markdown, idIndex, { cutAtReferences: false }).matches, markdown)
    : []), index));

  const contributions = results.filter((r) => r.items.length > 0).map((r) => ({ source: r.label, items: r.items }));
  const candidates = mergeDetections(contributions);
  const { outcomes, stats } = matchAuthorRows(authorRows, candidates);
  const consolidated = await consolidateWithLM(candidates);
  const { items: generatedKrt, carried } = reconcileWithAuthorKrt(consolidated.items, authorRows);

  // ── the two measures seeding cannot inflate ────────────────────────────────
  const authorNames = new Set(authorRows.map((r) => norm(r.resourceName)));
  const detected = results.flatMap((r) => r.items);
  const discovery = detected.filter((it) => !authorNames.has(norm(it.resourceName))).length;
  // echo: a detection whose name matches an author row but whose evidence does
  // not verify — i.e. the model reproduced a row it was handed without finding it.
  const echo = detected.filter((it) => authorNames.has(norm(it.resourceName))
    && it.evidence?.verification && it.evidence.verification.status !== 'verified').length;
  const echoable = detected.filter((it) => authorNames.has(norm(it.resourceName))).length;

  process.stderr.write(
    `    ${arm}  detections ${String(detected.length).padStart(4)}`
    + ` · discovery ${String(discovery).padStart(4)} · echo ${String(echo).padStart(3)}/${String(echoable).padStart(4)}`
    + ` · candidates ${String(candidates.length).padStart(4)} · generated ${String(generatedKrt.length).padStart(4)}`
    + ` · confirmed ${String(stats.confirmed).padStart(3)}\n`
  );

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}-${arm}.json`), JSON.stringify({
    name, arm, seedRows: seeds.length, authorRows,
    detections: Object.fromEntries(results.map((r) => [r.label, r.items])),
    detectionErrors: Object.fromEntries(results.filter((r) => r.error).map((r) => [r.label, r.error])),
    measures: { detected: detected.length, discovery, echo, echoable },
    candidatePool: candidates, grounding: stats, outcomes, generatedKrt,
    dropped: consolidated.dropped || [], carried: carried.length
  }, null, 1));
}

(async () => {
  const groupOrder = await getResourceTypeGroupOrder();
  const idIndex = await identifierIndexService.loadIndex().catch(() => null);
  process.stderr.write(`arms: ${ARMS.join(',')}   documents: ${CORPUS.length}\n`);

  for (const name of CORPUS) {
    const md = path.join(MD_CACHE, `${name}.md`);
    const krt = ['.csv', '.xlsx'].map((e) => path.join(DOCS, `${name}${e}`)).find((f) => fs.existsSync(f));
    const pdfPath = path.join(DOCS, `${name}.pdf`);
    if (!fs.existsSync(md) || !krt) { process.stderr.write(`\n▶ ${name}  SKIPPED\n`); continue; }

    const markdown = fs.readFileSync(md, 'utf-8');
    const index = buildEvidenceIndex(markdown);
    const authorRows = await loadAuthorKrt(krt);
    const verified = authorRows.filter((r) => rowInText(index, r));
    process.stderr.write(`\n▶ ${name}  (${authorRows.length} author rows, ${verified.length} verified in text)\n`);

    const ctx = { name, markdown, index, authorRows, groupOrder, pdfPath, idIndex };
    for (const arm of ARMS) {
      const seeds = arm === 'A' ? [] : (arm === 'C' ? verified : authorRows);
      try {
        await runArm(arm, { ...ctx, seeds });
      } catch (e) {
        process.stderr.write(`    ${arm}  FAILED: ${e.message}\n`);
      }
    }
  }
  process.stderr.write('\ndone\n');
  try { require(path.join(B, 'models')).sequelize.close(); } catch { /* not connected */ }
  process.exit(0);
})();
