#!/usr/bin/env node
/**
 * Analyse the A/B/C prompt arms.
 *
 *   A  branch prompts, no seed
 *   B  dev prompts + the FULL author KRT
 *   C  dev prompts + the author KRT filtered to rows found in the manuscript
 *
 * The engine was identical in all three, so differences are attributable to the
 * prompts and the seeding — nothing else.
 *
 * Two comparisons, answering different questions. Do not blur them:
 *   A vs B  prompts AND seeding together (the two designs as they exist)
 *   B vs C  seed QUALITY alone — same prompts, only the seed rows differ
 *
 * Offline: no LM calls.
 *
 * Usage: node scripts/dev/analyze-ab-arms.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const IN = path.join(ROOT, 'tmp/ab-arms');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');

const { buildEvidenceIndex, findAllOccurrences } =
  require(path.join(ROOT, 'src/backend/services/pdf-analysis/evidence.service'));

const ARMS = ['A', 'B', 'C'];
const LABEL = {
  A: 'A  branch prompts, no seed',
  B: 'B  dev prompts + full author KRT',
  C: 'C  dev prompts + verified-only seed'
};
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

function supportedFactory(index) {
  return (name, identifier) => {
    if (identifier && String(identifier).trim()) {
      const id = String(identifier).replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim();
      if (id.length >= 4 && findAllOccurrences(index, id, 1).length > 0) return true;
    }
    return Boolean(name && String(name).trim().length >= 4
      && findAllOccurrences(index, String(name), 1).length > 0);
  };
}

// ── load ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(IN)) { console.error(`No arm results in ${path.relative(ROOT, IN)}`); process.exit(1); }
const files = fs.readdirSync(IN).filter((f) => f.endsWith('.json'));
const byDoc = new Map();
for (const f of files) {
  const a = JSON.parse(fs.readFileSync(path.join(IN, f), 'utf-8'));
  if (!byDoc.has(a.name)) byDoc.set(a.name, {});
  byDoc.get(a.name)[a.arm] = a;
}
// only documents where every requested arm completed — a partial triple is not
// a comparison, and silently averaging over one would flatter whichever arm ran.
const docs = [...byDoc.entries()].filter(([, arms]) => ARMS.every((x) => arms[x])).sort();
const partial = [...byDoc.entries()].filter(([, arms]) => !ARMS.every((x) => arms[x]));

for (const [, arms] of docs) {
  const name = arms.A.name;
  const md = path.join(MD_DIR, `${name}.md`);
  if (!fs.existsSync(md)) continue;
  const supported = supportedFactory(buildEvidenceIndex(fs.readFileSync(md, 'utf-8')));
  for (const arm of ARMS) {
    const a = arms[arm];
    const det = Object.values(a.detections || {}).flat();
    a._det = det.length;
    a._detOk = det.filter((it) => supported(it.resourceName, it.identifier)).length;
    const authorNames = new Set((a.authorRows || []).map((r) => norm(r.resourceName)));
    const adds = (a.generatedKrt || []).filter((g) => !authorNames.has(norm(g.resourceName)));
    a._adds = adds.length;
    a._addsOk = adds.filter((g) => supported(g.resourceName, g.identifier)).length;

    // STRICTER than the echo metric. Echo asks "did the model's quote verify?",
    // and a quote verifies if that sentence exists — NOT if it is about this
    // resource. A seeded model can attach a real sentence to a row whose name
    // never appears. So also ask: is THIS ROW's own name or identifier in the
    // manuscript? A confirmation that fails this rests on a quote that may be
    // about something else entirely.
    const byName = new Map((a.authorRows || []).map((r) => [norm(r.resourceName), r]));
    const confirmedRows = (a.outcomes || [])
      .filter((o) => o.outcome === 'confirmed' || o.outcome === 'incomplete')
      .map((o) => byName.get(norm(o.resourceName)))
      .filter(Boolean);
    a._confirmed = confirmedRows.length;
    a._confirmedAnchored = confirmedRows.filter((r) => supported(r.resourceName, r.identifier)).length;
  }
}

const sum = (arm, fn) => docs.reduce((n, [, arms]) => n + fn(arms[arm]), 0);
const line = (c = '=') => console.log(c.repeat(104));

line();
console.log('A/B/C PROMPT ARMS — same engine, different prompts and seeding');
line();
console.log(`${docs.length} documents with all three arms complete` + (partial.length ? `   (${partial.length} incomplete, excluded)` : ''));
console.log('\nengine identical in every arm: same evidence verification, merge, consolidation and matcher.\n');

console.log('DISCOVERY — items found that are NOT author rows. Seeding cannot inflate this.');
line('-');
console.log('document                     author |    A disc    B disc    C disc |   A det   B det   C det');
line('-');
for (const [name, arms] of docs) {
  console.log(
    `${name.slice(0, 26).padEnd(26)} ${String((arms.A.authorRows || []).length).padStart(6)} |`
    + ARMS.map((x) => String(arms[x].measures.discovery).padStart(9)).join('') + ' |'
    + ARMS.map((x) => String(arms[x]._det).padStart(8)).join('')
  );
}
line('-');
console.log(
  `${'TOTAL'.padEnd(26)} ${String(sum('A', (a) => (a.authorRows || []).length)).padStart(6)} |`
  + ARMS.map((x) => String(sum(x, (a) => a.measures.discovery)).padStart(9)).join('') + ' |'
  + ARMS.map((x) => String(sum(x, (a) => a._det)).padStart(8)).join('')
);

console.log('\n\nECHO — author rows the detector reported whose evidence does NOT verify.');
console.log('This is the number that decides whether seeding produces real finds or repetition.');
line('-');
for (const x of ARMS) {
  const e = sum(x, (a) => a.measures.echo);
  const t = sum(x, (a) => a.measures.echoable);
  console.log(`  ${LABEL[x].padEnd(38)} ${String(e).padStart(4)} of ${String(t).padStart(4)} author-row detections unverified  (${pct(e, t)})`);
}

console.log('\n\nGROUNDING — how many author rows the pipeline could confirm.');
console.log('In a seeded arm this is NOT a clean recall measure: the model was handed the rows.');
line('-');
for (const x of ARMS) {
  const c = sum(x, (a) => a.grounding.confirmed || 0);
  const i = sum(x, (a) => a.grounding.incomplete || 0);
  const p = sum(x, (a) => a.grounding.partial || 0);
  const n = sum(x, (a) => a.grounding.notDetected || 0);
  const rows = c + i + p + n;
  console.log(`  ${LABEL[x].padEnd(38)} confirmed ${String(c).padStart(4)} · incomplete ${String(i).padStart(3)} · partial ${String(p).padStart(3)} · not detected ${String(n).padStart(4)}   located ${pct(c + i + p, rows)}`);
}

console.log('\n\nANCHORED CONFIRMATIONS — of the author rows the pipeline confirmed, how many');
console.log('have their OWN name or identifier in the manuscript? The rest rest on a quote');
console.log('that verified as text but may not be about that resource.');
line('-');
for (const x of ARMS) {
  const c = sum(x, (a) => a._confirmed);
  const anch = sum(x, (a) => a._confirmedAnchored);
  console.log(`  ${LABEL[x].padEnd(38)} ${String(anch).padStart(4)} of ${String(c).padStart(4)} anchored  (${pct(anch, c)})`);
}

console.log('\n\nDETECTION QUALITY and the GENERATED KRT');
line('-');
console.log('arm                                    detections  supported |  rows added  supported');
for (const x of ARMS) {
  console.log(
    `  ${LABEL[x].padEnd(36)} ${String(sum(x, (a) => a._det)).padStart(10)} ${(sum(x, (a) => a._detOk) + ' ' + pct(sum(x, (a) => a._detOk), sum(x, (a) => a._det))).padStart(11)} |`
    + ` ${String(sum(x, (a) => a._adds)).padStart(10)} ${(sum(x, (a) => a._addsOk) + ' ' + pct(sum(x, (a) => a._addsOk), sum(x, (a) => a._adds))).padStart(11)}`
  );
}

console.log('\n');
line();
console.log('READING THIS');
line();
const dA = sum('A', (a) => a.measures.discovery);
const dB = sum('B', (a) => a.measures.discovery);
const dC = sum('C', (a) => a.measures.discovery);
const cA = sum('A', (a) => a.grounding.confirmed || 0);
const cB = sum('B', (a) => a.grounding.confirmed || 0);
const cC = sum('C', (a) => a.grounding.confirmed || 0);
console.log(`  A vs B (prompts AND seeding): discovery ${dA} → ${dB} (${dB > dA ? '+' : ''}${dB - dA}), confirmed ${cA} → ${cB} (${cB > cA ? '+' : ''}${cB - cA})`);
console.log(`  B vs C (seed QUALITY only)  : discovery ${dB} → ${dC} (${dC > dB ? '+' : ''}${dC - dB}), confirmed ${cB} → ${cC} (${cC > cB ? '+' : ''}${cC - cB})`);
console.log(`  seed size: B ${sum('B', (a) => a.seedRows)} rows, C ${sum('C', (a) => a.seedRows)} rows`);
console.log('\n  "supported" = the name or identifier occurs in the manuscript. A FLOOR on');
console.log('  precision, not correctness: a row can be mentioned and still be a poor entry.');
if (partial.length) {
  console.log('\n  EXCLUDED (incomplete arm set):');
  for (const [n, arms] of partial) console.log(`    ${n} — has ${Object.keys(arms).sort().join(',')}`);
}
