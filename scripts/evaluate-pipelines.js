#!/usr/bin/env node
/**
 * Evaluate two versions of the pipeline across THREE stages, on the same corpus.
 *
 *   1. DETECTIONS   what each pipeline finds raw, per module, before any
 *                   consolidation. The only stage where the hallucination
 *                   control is visible: the branch verifies every detector
 *                   claim against the manuscript and DROPS the ones where
 *                   neither quote, name nor identifier occurs. Dev does not.
 *
 *   2. SUGGESTIONS  what the curator is asked to act on.
 *
 *   3. FINAL KRT    what the curator ends up with, simulated by accepting
 *                   EVERY suggestion. Both pipelines start from the same author
 *                   table, so the two final tables are directly comparable —
 *                   this is the deliverable, and the fairest comparison.
 *
 * WHY A ROW COUNT IS NOT A VERDICT
 * Both pipelines guarantee every author row survives into the Generated KRT,
 * so overlap with the author table is ~100% by construction. Everything
 * interesting is in what each pipeline ADDS — and "more" is only better if the
 * additions are real. So every added row, suggestion and final row from BOTH
 * sides is checked against the same converted markdown with the same
 * deterministic search, blind to which pipeline produced it.
 *
 * THAT CHECK IS A FLOOR, NOT CORRECTNESS. It asks whether the resource is
 * MENTIONED — necessary, not sufficient. Descriptive names ("Proteomics data")
 * score no on both sides even when the resource is discussed, so absolute rates
 * understate both pipelines while the comparison between them stays fair.
 *
 * Offline: no LM calls, no database.
 *
 * Usage: node scripts/evaluate-pipelines.js [--csv]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRANCH_DIR = path.join(ROOT, 'tmp/batch-check');
const DEV_DIR = path.join(ROOT, 'tmp/batch-check/devrun');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');

const { buildEvidenceIndex, findAllOccurrences } =
  require(path.join(ROOT, 'src/backend/services/pdf-analysis/evidence.service'));

/** Documents whose numbers are not usable for a given stage, with the reason. */
const EXCLUDED_SUGGESTIONS = {
  'WH1-000282-023-org-P-2':
    'dev suggestions truncated (0 produced) — tooling failure, not a quality signal'
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

/** Identical support test for both pipelines, at every stage. */
function makeSupported(index) {
  return (name, identifier) => {
    if (identifier && String(identifier).trim()) {
      const id = String(identifier).replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim();
      if (id.length >= 4 && findAllOccurrences(index, id, 1).length > 0) return true;
    }
    return Boolean(name && String(name).trim().length >= 4
      && findAllOccurrences(index, String(name), 1).length > 0);
  };
}

const isAdd = (s) => (s.type || s.action || '').includes('add');
const isEdit = (s) => /edit|update/.test(s.type || s.action || '');

/**
 * The table a curator would hold after accepting every suggestion.
 *
 * Starts from the author's own rows — never modified — then applies each
 * suggestion: an add appends a row, an edit fills the named column on the row
 * it targets. This is a SIMULATION of the accept path, not a call into it; it
 * mirrors what accepting does to the table, which is what we want to compare.
 */
function finalKrt(authorRows, suggestions) {
  const rows = (authorRows || []).map((r) => ({ ...r, origin: 'author' }));
  const byName = new Map(rows.map((r) => [norm(r.resourceName), r]));

  for (const s of suggestions || []) {
    const d = s.data || {};
    const name = d.resourceName || s.title || '';
    if (!String(name).trim()) continue;

    if (isAdd(s)) {
      if (byName.has(norm(name))) continue;         // already there — accepting is a no-op
      const row = {
        resourceType: d.resourceType || '', resourceName: name,
        identifier: d.identifier || '', source: d.source || '',
        newReuse: d.newReuse || '', origin: 'suggested'
      };
      rows.push(row);
      byName.set(norm(name), row);
    } else if (isEdit(s)) {
      const target = byName.get(norm(name));
      if (!target) continue;
      for (const col of ['identifier', 'source', 'newReuse', 'resourceType']) {
        // Suggestions only ever fill an EMPTY author cell; mirror that here so
        // the simulation cannot overwrite curated data.
        if (d[col] && !String(target[col] || '').trim()) {
          target[col] = d[col];
          target.origin = target.origin === 'author' ? 'author+filled' : target.origin;
        }
      }
    }
  }
  return rows;
}

function scoreRows(rows, supported, nameKey = 'resourceName', idKey = 'identifier') {
  let ok = 0;
  let withId = 0;
  for (const r of rows) {
    const name = r[nameKey] ?? r.data?.[nameKey] ?? r.title;
    const id = r[idKey] ?? r.data?.[idKey];
    if (supported(name, id)) ok++;
    if (String(id ?? '').trim()) withId++;
  }
  return { total: rows.length, supported: ok, withIdentifier: withId };
}

// ── gather ──────────────────────────────────────────────────────────────────
const docs = [];
for (const f of fs.readdirSync(BRANCH_DIR).filter((x) => x.endsWith('-artifacts.json')).sort()) {
  const b = JSON.parse(fs.readFileSync(path.join(BRANCH_DIR, f), 'utf-8'));
  if (!b.hasAuthorKrt) continue;
  const devFile = path.join(DEV_DIR, `${b.name}-dev.json`);
  const mdFile = path.join(MD_DIR, `${b.name}.md`);
  if (!fs.existsSync(devFile) || !fs.existsSync(mdFile)) continue;
  const d = JSON.parse(fs.readFileSync(devFile, 'utf-8'));
  const supported = makeSupported(buildEvidenceIndex(fs.readFileSync(mdFile, 'utf-8')));

  const authorNames = new Set((b.authorKrt || []).map((r) => norm(r.resourceName)));
  const adds = (items) => (items || []).filter((g) => !authorNames.has(norm(g.resourceName)));

  const side = (art) => {
    const det = {};
    for (const [mod, items] of Object.entries(art.detections || {})) {
      det[mod] = scoreRows(items || [], supported);
    }
    const sugg = art.suggestions || [];
    const fin = finalKrt(art.authorKrt, sugg);
    return {
      detections: det,
      detectionTotal: Object.values(det).reduce(
        (a, s) => ({ total: a.total + s.total, supported: a.supported + s.supported }),
        { total: 0, supported: 0 }
      ),
      generatedAdds: scoreRows(adds(art.generatedKrt), supported),
      suggestions: { all: sugg.length, add: sugg.filter(isAdd).length, edit: sugg.filter(isEdit).length },
      suggestionScore: scoreRows(sugg.filter(isAdd), supported),
      withEvidence: sugg.filter((s) => s.evidence?.quote).length,
      final: {
        rows: fin.length,
        added: fin.filter((r) => r.origin === 'suggested').length,
        addedScore: scoreRows(fin.filter((r) => r.origin === 'suggested'), supported),
        withIdentifier: fin.filter((r) => String(r.identifier || '').trim()).length
      }
    };
  };

  docs.push({
    name: b.name,
    authorRows: (b.authorKrt || []).length,
    excludedSuggestions: EXCLUDED_SUGGESTIONS[b.name] || null,
    dev: side(d),
    branch: side(b)
  });
}

// ── report ──────────────────────────────────────────────────────────────────
const line = (c = '=') => console.log(c.repeat(100));
const usable = docs.filter((x) => !x.excludedSuggestions);
const sum = (arr, fn) => arr.reduce((n, x) => n + fn(x), 0);

line();
console.log('STAGE 1 — DETECTIONS   raw output per module, before any consolidation');
line();
console.log('The branch VERIFIES each claim against the manuscript and drops the unsupported ones.');
console.log('Dev does neither. This is the only stage where that difference is directly visible.\n');
const mods = [...new Set(docs.flatMap((x) => [...Object.keys(x.dev.detections), ...Object.keys(x.branch.detections)]))];
console.log('module           dev items   supported |  branch items   supported');
line('-');
for (const m of mods) {
  const dt = sum(docs, (x) => x.dev.detections[m]?.total || 0);
  const ds = sum(docs, (x) => x.dev.detections[m]?.supported || 0);
  const bt = sum(docs, (x) => x.branch.detections[m]?.total || 0);
  const bs = sum(docs, (x) => x.branch.detections[m]?.supported || 0);
  console.log(`${m.padEnd(16)} ${String(dt).padStart(9)} ${(ds + ' ' + pct(ds, dt)).padStart(12)} | ${String(bt).padStart(13)} ${(bs + ' ' + pct(bs, bt)).padStart(12)}`);
}
const dT = sum(docs, (x) => x.dev.detectionTotal.total);
const dS = sum(docs, (x) => x.dev.detectionTotal.supported);
const bT = sum(docs, (x) => x.branch.detectionTotal.total);
const bS = sum(docs, (x) => x.branch.detectionTotal.supported);
line('-');
console.log(`${'TOTAL'.padEnd(16)} ${String(dT).padStart(9)} ${(dS + ' ' + pct(dS, dT)).padStart(12)} | ${String(bT).padStart(13)} ${(bS + ' ' + pct(bS, bT)).padStart(12)}`);

console.log('\n');
line();
console.log('STAGE 2 — AI SUGGESTIONS   what the curator is asked to act on');
line();
console.log(`(${usable.length} of ${docs.length} documents; see EXCLUDED below)\n`);
const ds2 = sum(usable, (x) => x.dev.suggestions.all);
const bs2 = sum(usable, (x) => x.branch.suggestions.all);
const dsa = sum(usable, (x) => x.dev.suggestionScore.total);
const dss = sum(usable, (x) => x.dev.suggestionScore.supported);
const bsa = sum(usable, (x) => x.branch.suggestionScore.total);
const bss = sum(usable, (x) => x.branch.suggestionScore.supported);
console.log(`  dev    : ${ds2} suggestions (${dsa} add) · ${dss} supported (${pct(dss, dsa)}) · ${sum(usable, (x) => x.dev.withEvidence)} with an evidence quote`);
console.log(`  branch : ${bs2} suggestions (${bsa} add) · ${bss} supported (${pct(bss, bsa)}) · ${sum(usable, (x) => x.branch.withEvidence)} with an evidence quote`);

console.log('\n');
line();
console.log('STAGE 3 — FINAL KRT   the table after accepting EVERY suggestion');
line();
console.log('Both start from the same author table, so these are directly comparable.\n');
console.log('document                    author |   dev rows  added  supported |  branch rows  added  supported');
line('-');
for (const x of usable) {
  console.log(
    `${x.name.slice(0, 26).padEnd(26)} ${String(x.authorRows).padStart(6)} |`
    + ` ${String(x.dev.final.rows).padStart(9)} ${String(x.dev.final.added).padStart(6)} ${pct(x.dev.final.addedScore.supported, x.dev.final.added).padStart(10)} |`
    + ` ${String(x.branch.final.rows).padStart(12)} ${String(x.branch.final.added).padStart(6)} ${pct(x.branch.final.addedScore.supported, x.branch.final.added).padStart(10)}`
  );
}
const f = (side, k) => sum(usable, (x) => x[side].final[k]);
const fs_ = (side) => sum(usable, (x) => x[side].final.addedScore.supported);
line('-');
console.log(
  `${'TOTAL'.padEnd(26)} ${String(sum(usable, (x) => x.authorRows)).padStart(6)} |`
  + ` ${String(f('dev', 'rows')).padStart(9)} ${String(f('dev', 'added')).padStart(6)} ${pct(fs_('dev'), f('dev', 'added')).padStart(10)} |`
  + ` ${String(f('branch', 'rows')).padStart(12)} ${String(f('branch', 'added')).padStart(6)} ${pct(fs_('branch'), f('branch', 'added')).padStart(10)}`
);
console.log(`\n  rows carrying an identifier:  dev ${f('dev', 'withIdentifier')}/${f('dev', 'rows')} (${pct(f('dev', 'withIdentifier'), f('dev', 'rows'))})   branch ${f('branch', 'withIdentifier')}/${f('branch', 'rows')} (${pct(f('branch', 'withIdentifier'), f('branch', 'rows'))})`);
console.log(`  supported rows ADDED to the author table:  dev ${fs_('dev')}   branch ${fs_('branch')}`);

console.log('\nEXCLUDED from stage 2 and 3:');
for (const [k, why] of Object.entries(EXCLUDED_SUGGESTIONS)) console.log(`  ${k}: ${why}`);
console.log('\nREMINDER: "supported" = the name or identifier occurs in the manuscript.');
console.log('That is a FLOOR on precision, not a measure of correctness — a row can be');
console.log('mentioned and still be a poor KRT entry. Only a curator settles that.');
