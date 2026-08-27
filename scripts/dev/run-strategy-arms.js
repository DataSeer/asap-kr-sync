#!/usr/bin/env node
/**
 * Run each corpus manuscript through both detection strategies and score them.
 *
 * The question: does seeding the detection prompts with the author's own KRT
 * produce better results than detecting blind, and which recovers more of what
 * an author left out.
 *
 * NOTHING IS PERSISTED. No submission is created, no job row, no S3 object.
 * Every stage is called as a pure function, the way batch-detection-check.js
 * already does — the strategies' seeds come from `buildAuthorSeeds(rows)`, which
 * takes parsed rows rather than reading `krt_data`, and the prompts are read
 * from the files the registry names. So a run is repeatable, costs only model
 * calls, and cannot disturb the dev instance.
 *
 * WHAT MAKES THE ARMS COMPARABLE
 * Both arms see the same manuscript and the same author KRT. The only
 * difference is what the detection prompts are given: `seeded-v1` passes the
 * author's rows as seeds, `blind-v1` passes none and uses a different prompt.
 * That is the whole independent variable, and it is resolved from
 * `config/pipelines.js` rather than hard-coded here, so the experiment tests
 * what the app actually ships.
 *
 * THE ABLATION
 * `--ablate 0.5` removes half the author's rows before the seeded arm sees
 * them, and scores BOTH arms against the FULL table. That splits the score in
 * two, and the split is the point:
 *
 *   kept rows    — could be found by copying the seed. Seeding should win here,
 *                  and winning proves little.
 *   removed rows — the seeded arm was never told about them. Recovery here is
 *                  real discovery, and it is the number that answers "which
 *                  strategy finds what the author forgot".
 *
 * Removal is deterministic per (manuscript, level) so two runs of the same
 * configuration remove the same rows and can be compared directly.
 *
 * Usage:
 *   node scripts/dev/run-strategy-arms.js --dry-run
 *   node scripts/dev/run-strategy-arms.js --limit 1              # one manuscript, both arms
 *   node scripts/dev/run-strategy-arms.js --ablate 0.5
 *   node scripts/dev/run-strategy-arms.js --arms blind-v1
 *
 * Unpublished manuscripts — output stays under tmp/, which is gitignored.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const _warn = console.warn;
console.warn = (...args) => {
  if (String(args[0] || '').includes('Duplicate headers')) return;
  _warn(...args);
};

const ROOT = path.join(__dirname, '../..');
const parserService = require(path.join(ROOT, 'src/backend/services/krt/parser.service'));
const { normalizeResourceType } = require(path.join(ROOT, 'src/backend/services/krt/validator.service'));
const { buildAuthorSeeds } = require(path.join(ROOT, 'src/backend/services/krt/author-krt-seeds.service'));
const { PIPELINES } = require(path.join(ROOT, 'src/backend/config/pipelines'));
const { getStrategy } = require(path.join(ROOT, 'src/backend/services/detection/registry'));
const { buildEvidenceIndex, attachEvidence } = require(path.join(ROOT, 'src/backend/services/pdf-analysis/evidence.service'));
const { presenceForRows } = require(path.join(ROOT, 'src/backend/services/krt-grounding/krt-grounding.service'));

const datasetsService = require(path.join(ROOT, 'src/backend/services/datasets/datasets.service'));
const materialsService = require(path.join(ROOT, 'src/backend/services/materials/materials.service'));
const protocolsService = require(path.join(ROOT, 'src/backend/services/protocols/protocols.service'));

const CORPUS_FILE = path.join(ROOT, 'tmp/corpus/corpus.json');
const PRESENCE_FILE = path.join(ROOT, 'tmp/corpus/presence.json');
const FAMILY_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tmp/corpus/resource-type-families.json'), 'utf-8'));
const OUT_DIR = path.join(ROOT, 'tmp/corpus/runs');

const inRepo = (p) => (p && !path.isAbsolute(p) ? path.join(ROOT, p) : p);
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const familyOf = (t) => FAMILY_MAP[normalizeResourceType(t) || t] || FAMILY_MAP[t] || 'other';

/** The three detectors whose prompts differ between the arms. */
const DETECTORS = ['datasets', 'materials', 'protocols'];
const FAMILY_FOR = { datasets: 'dataset', materials: 'lab_material', protocols: 'protocol' };

/**
 * Deterministic row removal.
 *
 * Seeded from the manuscript id and the level, so the same configuration always
 * removes the same rows: two arms of one experiment must be handed identical
 * tables, and a re-run has to be comparable with the first.
 *
 * Rows carrying an identifier are removed preferentially. A row with no
 * identifier is largely unrecoverable by either arm — nothing anchors it — so
 * removing those would spend the ablation budget on rows that measure nothing.
 */
function ablate(rows, fraction, seedKey) {
  if (!fraction) return { kept: rows, removed: [] };

  const rng = (() => {
    let h = parseInt(crypto.createHash('sha256').update(seedKey).digest('hex').slice(0, 8), 16);
    return () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
  })();

  const withId = rows.filter((r) => String(r.identifier || '').trim());
  const withoutId = rows.filter((r) => !String(r.identifier || '').trim());
  const target = Math.round(rows.length * fraction);

  const shuffled = [...withId].map((r) => ({ r, k: rng() })).sort((a, b) => a.k - b.k).map((x) => x.r);
  const removed = new Set(shuffled.slice(0, Math.min(target, shuffled.length)));

  return {
    kept: rows.filter((r) => !removed.has(r)),
    removed: [...removed],
    note: removed.size < target
      ? `wanted ${target}, only ${removed.size} rows carry an identifier`
      : null
  };
}

async function loadRows(krtFile) {
  const ext = path.extname(krtFile).toLowerCase();
  const mime = ext === '.csv' ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const parsed = await parserService.parseFile(fs.readFileSync(krtFile), mime, path.basename(krtFile));
  const v = (r, n) => String(r?.[n] ?? '').trim();
  return parsed
    .filter((r) => v(r, 'RESOURCE NAME') || v(r, 'IDENTIFIER'))
    .map((r, i) => ({
      id: `row-${i}`,
      resourceType: v(r, 'RESOURCE TYPE'),
      resourceName: v(r, 'RESOURCE NAME'),
      identifier: v(r, 'IDENTIFIER'),
      source: v(r, 'SOURCE'),
      additionalInformation: v(r, 'ADDITIONAL INFORMATION')
    }));
}

/** The prompt and seeds one arm hands one detector. */
function inputFor(pipeline, detector, authorRows) {
  const strategy = getStrategy(pipeline.strategies[detector]);
  const isSeeded = strategy.id.endsWith('.seeded');

  const familyRows = authorRows.filter((r) => familyOf(r.resourceType) === FAMILY_FOR[detector]);
  const seeds = isSeeded ? buildAuthorSeeds(familyRows) : [];

  // Materials picks between a seeded and a discovery prompt by whether it has
  // anything to seed with — reproduced here rather than assumed, because an
  // ablation can empty the seed list and the choice must follow.
  const promptFile = (detector === 'materials' && isSeeded && seeds.length === 0)
    ? strategy.promptFiles[1]
    : strategy.promptFiles[0];

  return {
    strategyId: strategy.id,
    seeds,
    seedTitle: strategy.seedTitle,
    prompt: fs.readFileSync(promptFile, 'utf-8'),
    promptFile: path.relative(ROOT, promptFile),
    signalsPrompt: strategy.signalsPromptFiles?.[0]
      ? fs.readFileSync(strategy.signalsPromptFiles[0], 'utf-8') : undefined
  };
}

async function detect(detector, markdown, input) {
  if (detector === 'datasets') {
    const r = await datasetsService.detectDatasets(markdown, {
      prompt: input.prompt, signalsPrompt: input.signalsPrompt
    });
    return datasetsService.buildKrtItemsDatasets(r.resources);
  }
  if (detector === 'materials') {
    const r = await materialsService.detectMaterials(markdown, { prompt: input.prompt });
    return materialsService.buildKrtItemsMaterials(r.resources);
  }
  const r = await protocolsService.detectProtocols(markdown, { prompt: input.prompt });
  return protocolsService.buildKrtItemsProtocols(r.resources);
}

/**
 * Did the arm find this author row?
 *
 * Matched on identifier first, then on a normalised name. Deliberately
 * generous: the question is whether the resource was discovered at all, not
 * whether the wording matches, and a stricter test would punish the blind arm
 * for not guessing the author's phrasing — which is the thing it cannot do by
 * construction and not what we are measuring.
 */
function matches(row, items) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const ids = norm(row.identifier);
  const name = norm(row.resourceName);
  if (!ids && !name) return false;

  return items.some((it) => {
    const itemId = norm(it.identifier);
    if (ids && itemId && (ids.includes(itemId) || itemId.includes(ids))) return true;
    const itemName = norm(it.resourceName);
    return name && itemName && name.length > 4
      && (name.includes(itemName) || itemName.includes(name));
  });
}

async function runArm({ entry, pipeline, markdown, fullRows, ablation, staggerMs }) {
  const items = {};
  const evidence = {};
  const inputs = {};
  const index = buildEvidenceIndex(markdown);

  for (const detector of DETECTORS) {
    const input = inputFor(pipeline, detector, ablation.kept);
    inputs[detector] = {
      strategy: input.strategyId, seedCount: input.seeds.length, promptFile: input.promptFile
    };
    try {
      const found = await detect(detector, markdown, input);
      const { items: grounded, stats } = attachEvidence(found, index, { label: detector });
      items[detector] = grounded;
      evidence[detector] = stats;
    } catch (err) {
      items[detector] = [];
      evidence[detector] = { error: String(err.message).slice(0, 120) };
    }
    if (staggerMs) await sleep(staggerMs);
  }

  const all = Object.values(items).flat();

  // Scored against the FULL author table, split by what the arm was shown.
  const score = (rows) => {
    const hit = rows.filter((r) => matches(r, all)).length;
    return { rows: rows.length, found: hit, pct: rows.length ? Math.round((hit / rows.length) * 100) : null };
  };

  return {
    pipeline: pipeline.id,
    inputs,
    detected: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length])),
    detectedTotal: all.length,
    // verified + embellished, matching what the pipeline KEEPS. `dropUnsupported`
    // discards only the items whose quote AND resource are both absent from the
    // manuscript; an embellished item is a real find whose quote is not verbatim,
    // and counting it as unsupported understated the seeded arm badly — its
    // materials came back 100% embellished and read as 0 supported.
    supported: Object.fromEntries(Object.entries(evidence).map(
      ([k, st]) => [k, st.error ? null : (st.verified || 0) + (st.embellished || 0)]
    )),
    evidence,
    recall: {
      all: score(fullRows),
      kept: score(ablation.kept),
      removed: ablation.removed.length ? score(ablation.removed) : null
    }
  };
}

async function main() {
  if (!fs.existsSync(CORPUS_FILE)) {
    console.error('Run inventory-corpus.js --select N --json tmp/corpus/corpus.json first.');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number(arg('--limit', Infinity));
  const ablateFraction = Number(arg('--ablate', 0));
  const staggerMs = Number(arg('--stagger', 3)) * 1000;
  const armIds = (arg('--arms', Object.keys(PIPELINES).join(','))).split(',');

  const { corpus } = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf-8'));
  const markdownBySha = new Map(
    JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf-8')).scored.map((s) => [s.pdfSha, s.markdown])
  );

  // Two different reasons a manuscript is not in the queue, reported apart:
  // missing markdown is a gap in the corpus, --limit is a choice.
  const withMarkdown = corpus.filter((c) => markdownBySha.has(c.pdfSha));
  const missing = corpus.length - withMarkdown.length;
  const queue = withMarkdown.slice(0, Number.isFinite(limit) ? limit : withMarkdown.length);

  console.log(`corpus     ${corpus.length} manuscripts`
    + (missing ? `, ${missing} skipped for want of markdown` : '')
    + (queue.length < withMarkdown.length ? `, ${queue.length} selected by --limit` : ''));
  console.log(`arms       ${armIds.join(', ')}`);
  console.log(`ablation   ${ablateFraction ? `${Math.round(ablateFraction * 100)}% of identifier-bearing rows removed` : 'none'}`);
  console.log(`runs       ${queue.length * armIds.length}   (${DETECTORS.length} model calls each)`);

  if (dryRun) {
    console.log('\n--dry-run: no model calls. Seeds each arm would receive:\n');
    for (const entry of queue) {
      const rows = await loadRows(inRepo(entry.krt));
      const ab = ablate(rows, ablateFraction, `${entry.manuscriptId}:${ablateFraction}`);
      console.log(`  ${entry.manuscriptId.slice(0, 38)}  ${rows.length} rows`
        + (ablateFraction ? ` → ${ab.kept.length} kept, ${ab.removed.length} removed` : ''));
      for (const armId of armIds) {
        const counts = DETECTORS.map((d) => `${d}=${inputFor(PIPELINES[armId], d, ab.kept).seeds.length}`);
        console.log(`      ${armId.padEnd(10)} seeds: ${counts.join('  ')}`);
      }
    }
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  const results = [];

  for (const [i, entry] of queue.entries()) {
    const fullRows = await loadRows(inRepo(entry.krt));
    const ablation = ablate(fullRows, ablateFraction, `${entry.manuscriptId}:${ablateFraction}`);
    const markdown = fs.readFileSync(inRepo(markdownBySha.get(entry.pdfSha)), 'utf-8');

    for (const armId of armIds) {
      const label = `${i + 1}/${queue.length} ${entry.manuscriptId.slice(0, 30)} ${armId}`;
      try {
        const run = await runArm({
          entry, pipeline: PIPELINES[armId], markdown, fullRows, ablation, staggerMs
        });
        const record = {
          manuscriptId: entry.manuscriptId,
          pdfSha: entry.pdfSha,
          ablation: { fraction: ablateFraction, kept: ablation.kept.length, removed: ablation.removed.length },
          ...run
        };
        results.push(record);
        const tag = `${entry.pdfSha.slice(0, 12)}-${armId}-ab${Math.round(ablateFraction * 100)}`;
        fs.writeFileSync(path.join(OUT_DIR, `${tag}.json`), JSON.stringify(record, null, 2));

        const r = run.recall;
        console.log(`  ok   ${label}  detected ${run.detectedTotal}`
          + `  recall all ${r.all.pct}%`
          + (r.removed ? `  removed ${r.removed.pct}%` : ''));
      } catch (err) {
        console.log(`  FAIL ${label}  ${String(err.message).slice(0, 80)}`);
      }
    }
  }

  const summary = path.join(OUT_DIR, `summary-ab${Math.round(ablateFraction * 100)}.json`);
  fs.writeFileSync(summary, JSON.stringify(results, null, 2));

  console.log('\n── recall against the author table, by arm ──────────────────────────');
  for (const armId of armIds) {
    const mine = results.filter((r) => r.pipeline === armId);
    if (!mine.length) continue;
    const agg = (pick) => {
      const rows = mine.reduce((n, r) => n + (pick(r)?.rows || 0), 0);
      const found = mine.reduce((n, r) => n + (pick(r)?.found || 0), 0);
      return rows ? `${Math.round((found / rows) * 100)}% (${found}/${rows})` : 'n/a';
    };
    console.log(`  ${armId.padEnd(10)} all ${agg((r) => r.recall.all).padEnd(18)}`
      + `kept ${agg((r) => r.recall.kept).padEnd(18)}`
      + `removed ${agg((r) => r.recall.removed)}`);
    console.log(`  ${''.padEnd(10)} detected ${mine.reduce((n, r) => n + r.detectedTotal, 0)} items`);
  }
  console.log(`\n${Math.round((Date.now() - started) / 60000)} min · per-run JSON in ${path.relative(ROOT, OUT_DIR)}`);
  console.log('Unpublished manuscripts — keep this under tmp/, never commit it.');
}

main().catch((err) => { console.error(err); process.exit(1); });
