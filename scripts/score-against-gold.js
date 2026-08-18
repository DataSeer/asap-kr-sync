#!/usr/bin/env node
/**
 * Score a pipeline run against the gold linkage, on TWO axes.
 *
 * The question that motivated this: when the pipeline fails to produce an
 * author's row, did it never look at the right passage, or did it read the
 * right passage and name the resource differently? Those are different bugs
 * with different fixes, and every measure we had collapsed them into one
 * number.
 *
 *   entity axis  — did the product matcher link a candidate to this author row?
 *                  Taken from the run's own `outcomes`, so this measures the
 *                  shipped matcher, not a reimplementation of it.
 *   chunk axis   — did ANY candidate cite a passage in this row's gold set?
 *                  Computed from candidate evidence offsets.
 *
 *                    | entity matched        | entity missed
 *   cited gold chunk | correct find          | RIGHT PASSAGE, WRONG ENTITY
 *   cited elsewhere  | right name, odd quote | missed
 *
 * Why not score on chunk alone: it would credit the misattribution failure the
 * A/B/C experiment found — a real sentence from the right neighbourhood
 * attached to a row never actually located would count as a hit, and arm B
 * would come out looking correct. The two axes have to stay separate.
 *
 * Candidates come from `candidatePool`, which is pre-reconciliation. The
 * generated KRT is not usable here: `reconcileWithAuthorKrt` injects the
 * author's own rows into it, so scoring against it would score the input.
 *
 * Chunk crowding is reported separately. Only 43% of author rows sit alone in
 * their sentence, so a citation into a chunk shared with twenty other rows is
 * far weaker evidence than one into a chunk of its own.
 *
 * Offline: no LM calls, no database.
 *
 * SCOPE, and the bias it carries. By default this scores only rows whose gold
 * linkage is SETTLED — decided automatically or confirmed by a human. Rows still
 * awaiting review are excluded, and so are documents where too few rows are
 * settled for the remainder to represent them.
 *
 * That exclusion is not neutral and the output says so. The unreviewed pile IS
 * the hard aliasing cases, by construction: they are unreviewed precisely
 * because no rule could settle them. Dropping them understates the naming
 * problem and flatters the pipeline. Measured both ways, the "right passage,
 * wrong entity" cell moves from 29-30% to 14-17%. Read these figures as
 * "performance on rows whose linkage is unambiguous", never as overall
 * performance.
 *
 * Usage: node scripts/score-against-gold.js [--run 1,2] [--arms A,B,C]
 *   --include-unsettled   also score rows still awaiting review
 *   --min-coverage <pct>  drop documents below this share of settled rows
 *                         (default 45)
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const GOLD = path.join(ROOT, 'tmp/krt-linkage');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');
const OUT = path.join(ROOT, 'tmp/krt-linkage/scores');
const RUNS = { 1: path.join(ROOT, 'tmp/ab-arms-run1'), 2: path.join(ROOT, 'tmp/ab-arms-run2') };

const { chunkAt } = require('./build-krt-linkage');

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : dflt; };
const STRICT = !process.argv.includes('--include-unsettled');
const MIN_COVERAGE = Number(arg('--min-coverage', 45));
const ARMS = arg('--arms', 'A,B,C').split(',');
const RUN_IDS = arg('--run', '1,2').split(',').map(Number);

const LABEL = { A: 'A — separated (no seed)', B: 'B — fused (full author KRT)', C: 'C — fused (verified-only seed)' };
const ENTITY_MATCHED = new Set(['confirmed', 'incomplete', 'partial']);
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

/**
 * Rows whose gold linkage is trustworthy. Everything auto-decided qualifies;
 * rows still sitting in the review pile with no human verdict do not, and are
 * reported under their own denominator rather than silently folded in.
 */
function isSettled(row) {
  if (row.verdict) return row.verdict === 'LINKED' || row.verdict === 'GROUPED';
  return row.bucket !== 'tokens-only' && row.bucket !== 'not-found';
}

function scoreDocument(gold, artifact, md) {
  const goldChunks = new Map();          // key -> Set(chunk starts)
  for (const r of gold) goldChunks.set(r.key, new Set(r.chunks.map((c) => c.start)));

  // Every chunk any candidate cited, from its located evidence offset.
  const cited = new Set();
  for (const c of (artifact.candidatePool || [])) {
    const off = c.evidence?.offset;
    if (typeof off !== 'number' || off < 0) continue;
    const ch = chunkAt(md, off, (c.evidence.quote || c.resourceName || '').length || 1);
    if (ch) cited.add(ch.start);
  }

  const byName = new Map();
  for (const o of (artifact.outcomes || [])) {
    const k = String(o.resourceName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!byName.has(k)) byName.set(k, o);
  }

  const rows = [];
  for (const r of gold) {
    const chunks = goldChunks.get(r.key);
    const nameKey = String(r.resourceName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const outcome = byName.get(nameKey);
    const entity = Boolean(outcome && ENTITY_MATCHED.has(outcome.outcome));

    const hit = [...chunks].filter((s) => cited.has(s));
    const chunk = hit.length > 0;
    // A hit into a chunk shared with many rows identifies almost nothing.
    const exclusive = hit.some((s) => {
      const c = r.chunks.find((x) => x.start === s);
      return c && c.rowsSharing === 1;
    });

    rows.push({
      key: r.key, document: r.document, resourceName: r.resourceName,
      resourceType: r.resourceType, identifier: r.identifier, bucket: r.bucket,
      settled: isSettled(r), locatable: chunks.size > 0,
      entity, chunk, exclusive,
      goldChunks: chunks.size, chunksHit: hit.length,
      coverage: chunks.size ? hit.length / chunks.size : null,
      outcome: outcome?.outcome || 'not_detected',
      matchedBy: outcome?.matchedBy || ''
    });
  }
  return rows;
}

function summarise(rows) {
  const scope = rows.filter((r) => r.locatable && (!STRICT || r.settled));
  const cell = (e, c) => scope.filter((r) => r.entity === e && r.chunk === c).length;
  const covered = scope.filter((r) => r.coverage !== null);
  return {
    n: scope.length,
    notLocatable: rows.filter((r) => !r.locatable).length,
    unsettled: rows.filter((r) => r.locatable && !r.settled).length,
    correct: cell(true, true),
    wrongEntity: cell(false, true),
    oddQuote: cell(true, false),
    missed: cell(false, false),
    exclusive: scope.filter((r) => r.chunk && r.exclusive).length,
    coverage: covered.length
      ? covered.reduce((s, r) => s + r.coverage, 0) / covered.length : 0
  };
}

(async () => {
  if (!fs.existsSync(GOLD)) { console.error('No gold linkage — run build-krt-linkage.js first.'); process.exit(1); }
  const goldByDoc = new Map();
  const dropped = [];
  for (const f of fs.readdirSync(GOLD).filter((x) => x.endsWith('.json'))) {
    const rows = JSON.parse(fs.readFileSync(path.join(GOLD, f), 'utf-8'));
    if (!rows.length) continue;
    // A document whose settled rows are a small minority cannot be represented
    // by them: what survives is its easy tail, not the document.
    const settled = rows.filter(isSettled).length;
    const share = Math.round((settled / rows.length) * 100);
    if (STRICT && share < MIN_COVERAGE) {
      dropped.push({ document: rows[0].document, rows: rows.length, settled, share });
      continue;
    }
    goldByDoc.set(rows[0].document, rows);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const table = [];
  const allRows = [];

  for (const run of RUN_IDS) {
    const dir = RUNS[run];
    if (!dir || !fs.existsSync(dir)) { console.error(`run ${run}: not found`); continue; }
    for (const arm of ARMS) {
      const rows = [];
      for (const [doc, gold] of goldByDoc) {
        const p = path.join(dir, `${doc}-${arm}.json`);
        const mdPath = path.join(MD_DIR, `${doc}.md`);
        if (!fs.existsSync(p) || !fs.existsSync(mdPath)) continue;
        const artifact = JSON.parse(fs.readFileSync(p, 'utf-8'));
        rows.push(...scoreDocument(gold, artifact, fs.readFileSync(mdPath, 'utf-8')));
      }
      if (!rows.length) continue;
      const s = summarise(rows);
      table.push({ run, arm, ...s });
      allRows.push(...rows.map((r) => ({ run, arm, ...r })));
    }
  }

  const line = (c = '=') => console.log(c.repeat(100));
  line();
  console.log('SCORED AGAINST THE GOLD LINKAGE' + (STRICT ? '  [strict: settled rows only]' : ''));
  line();
  const first = table[0];
  console.log(`SCOPE: ${first.n} author rows`
    + (STRICT ? ' whose gold linkage is SETTLED' : ' (including rows awaiting review)'));
  console.log(`  excluded: ${first.notLocatable} not locatable in the manuscript`
    + (STRICT ? `, ${first.unsettled} awaiting review` : '')
    + (dropped.length ? `, ${dropped.length} whole documents below ${MIN_COVERAGE}% settled` : ''));
  for (const d of dropped) {
    console.log(`            ${d.document.slice(0, 28).padEnd(30)} ${d.settled}/${d.rows} settled (${d.share}%)`);
  }
  if (STRICT) {
    console.log('\n  BIAS: the excluded rows are the hard aliasing cases by construction —');
    console.log('  they are unreviewed because no rule could settle them. These figures');
    console.log('  UNDERSTATE the naming problem. Read as "performance on rows whose');
    console.log('  linkage is unambiguous", not as overall performance.');
  }
  console.log('\nThe question: when a row is missed, did the pipeline never see the passage,');
  console.log('or read it and name the resource differently?\n');
  console.log('run arm                              correct   RIGHT PASSAGE    right name    missed   of which');
  console.log('                                                WRONG ENTITY    odd evidence          exclusive');
  line('-');
  for (const t of table) {
    console.log(
      `${String(t.run).padEnd(4)}${LABEL[t.arm].padEnd(32)}`
      + `${String(t.correct).padStart(5)} ${pct(t.correct, t.n).padStart(5)}`
      + `${String(t.wrongEntity).padStart(8)} ${pct(t.wrongEntity, t.n).padStart(5)}`
      + `${String(t.oddQuote).padStart(9)} ${pct(t.oddQuote, t.n).padStart(5)}`
      + `${String(t.missed).padStart(7)} ${pct(t.missed, t.n).padStart(5)}`
      + `${String(t.exclusive).padStart(8)}`
    );
  }
  line('-');
  console.log('\nCHUNK-SET COVERAGE — of a row\'s gold passages, the share any candidate cited.');
  console.log('This is how a grouped row scores: several individual rows covering all its');
  console.log('passages count as found, with no grouping policy required.');
  for (const t of table) {
    console.log(`  run ${t.run}  ${LABEL[t.arm].padEnd(32)} ${(t.coverage * 100).toFixed(0)}%`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'asap-kr-sync gold scorer';
  const ws = wb.addWorksheet('Scored rows', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Run', key: 'run', width: 6 }, { header: 'Arm', key: 'arm', width: 6 },
    { header: 'Document', key: 'document', width: 26 },
    { header: 'RESOURCE NAME', key: 'resourceName', width: 34 },
    { header: 'IDENTIFIER', key: 'identifier', width: 24 },
    { header: 'Linkage case', key: 'bucket', width: 16 },
    { header: 'Gold verdict settled', key: 'settled', width: 18 },
    { header: 'Entity matched', key: 'entity', width: 14 },
    { header: 'Cited a gold passage', key: 'chunk', width: 18 },
    { header: 'Exclusive passage', key: 'exclusive', width: 16 },
    { header: 'Gold passages', key: 'goldChunks', width: 13 },
    { header: 'Passages hit', key: 'chunksHit', width: 12 },
    { header: 'Outcome', key: 'outcome', width: 14 },
    { header: 'Matched by', key: 'matchedBy', width: 14 },
    { header: 'CELL', key: 'cell', width: 26 }
  ];
  ws.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
  const CELL = (r) => (r.entity && r.chunk ? 'correct find'
    : (!r.entity && r.chunk ? 'RIGHT PASSAGE, WRONG ENTITY'
      : (r.entity ? 'right name, odd evidence' : 'missed')));
  const TINT = {
    'correct find': 'FFE7F6E7', 'RIGHT PASSAGE, WRONG ENTITY': 'FFFFF3D6',
    'right name, odd evidence': 'FFEDE7F6', missed: 'FFFBE4E4'
  };
  for (const r of allRows.filter((x) => x.locatable)) {
    const cell = CELL(r);
    const added = ws.addRow({ ...r, cell, settled: r.settled ? 'yes' : 'awaiting review',
      entity: r.entity ? 'yes' : 'no', chunk: r.chunk ? 'yes' : 'no', exclusive: r.exclusive ? 'yes' : '' });
    added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT[cell] } };
    added.alignment = { vertical: 'top', wrapText: true };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  await wb.xlsx.writeFile(path.join(OUT, '_SCORES.xlsx'));
  console.log(`\n  -> ${path.relative(ROOT, OUT)}/_SCORES.xlsx  (${allRows.filter((x) => x.locatable).length} scored rows)`);
})();
