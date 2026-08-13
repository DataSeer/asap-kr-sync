#!/usr/bin/env node
/**
 * Compare the dev pipeline against the feature branch on the same manuscripts.
 *
 * The two pipelines answer different questions, so a raw row count is not a
 * verdict. Both Generated KRTs contain every author row by construction (both
 * have reconcileWithAuthorKrt), so the comparison lives entirely in what each
 * pipeline ADDS — and "more rows" could be better recall or more noise.
 *
 * So every added row and every suggestion from BOTH sides is checked against
 * the same converted markdown with the same deterministic search. The checker
 * has no idea which pipeline produced a row.
 *
 * Offline: no LM calls, no database.
 *
 * Usage: node scripts/compare-dev-vs-branch.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRANCH_DIR = path.join(ROOT, 'tmp/batch-check');
const DEV_DIR = path.join(ROOT, 'tmp/batch-check/devrun');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');

const { buildEvidenceIndex, findAllOccurrences } =
  require(path.join(ROOT, 'src/backend/services/pdf-analysis/evidence.service'));

/** Documents whose numbers are not usable, with the reason stated. */
const EXCLUDED = {
  'WH1-000282-023-org-P-2':
    'dev suggestions truncated (0 produced) — tooling failure, not a quality signal'
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Is this resource actually discussed in the manuscript?
 * Name OR identifier occurring in the text. Identical test for both pipelines.
 */
function supported(index, name, identifier) {
  if (identifier && String(identifier).trim()) {
    const id = String(identifier).replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim();
    if (id.length >= 4 && findAllOccurrences(index, id, 1).length > 0) return true;
  }
  if (name && String(name).trim().length >= 4) {
    if (findAllOccurrences(index, String(name), 1).length > 0) return true;
  }
  return false;
}

/** Rows in the Generated KRT that are NOT in the author's table. */
function additions(generated, authorRows) {
  const authorNames = new Set(authorRows.map((r) => norm(r.resourceName)));
  return generated.filter((g) => !authorNames.has(norm(g.resourceName)));
}

function scoreRows(index, rows, nameKey, idKey) {
  let ok = 0;
  let withId = 0;
  for (const r of rows) {
    // A suggestion keeps its row values under `data` (with the name mirrored on
    // `title`); a Generated KRT row keeps them at the top level. Reading only
    // the top level scored every suggestion 0%, which is how this bug announced
    // itself — an impossible number on BOTH pipelines at once.
    const name = r[nameKey] ?? r.data?.[nameKey] ?? r.title;
    const id = r[idKey] ?? r.data?.[idKey];
    if (supported(index, name, id)) ok++;
    if (String(id ?? '').trim()) withId++;
  }
  return { total: rows.length, supported: ok, withIdentifier: withId };
}

/** Suggestions that propose adding a row, normalised across both shapes. */
function addSuggestions(suggestions) {
  return (suggestions || []).filter((s) => (s.type || s.action || '').includes('add'));
}

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

const rows = [];
for (const f of fs.readdirSync(BRANCH_DIR).filter((x) => x.endsWith('-artifacts.json')).sort()) {
  const b = JSON.parse(fs.readFileSync(path.join(BRANCH_DIR, f), 'utf-8'));
  if (!b.hasAuthorKrt) continue;
  const devFile = path.join(DEV_DIR, `${b.name}-dev.json`);
  if (!fs.existsSync(devFile)) continue;
  const d = JSON.parse(fs.readFileSync(devFile, 'utf-8'));

  const mdPath = path.join(MD_DIR, `${b.name}.md`);
  if (!fs.existsSync(mdPath)) continue;
  const index = buildEvidenceIndex(fs.readFileSync(mdPath, 'utf-8'));

  const bAdds = additions(b.generatedKrt || [], b.authorKrt || []);
  const dAdds = additions(d.generatedKrt || [], d.authorKrt || []);

  rows.push({
    name: b.name,
    excluded: EXCLUDED[b.name] || null,
    authorRows: (b.authorKrt || []).length,
    branch: {
      generated: (b.generatedKrt || []).length,
      adds: scoreRows(index, bAdds, 'resourceName', 'identifier'),
      suggestions: (b.suggestions || []).length,
      addSuggestions: scoreRows(index, addSuggestions(b.suggestions), 'resourceName', 'identifier'),
      withEvidence: (b.suggestions || []).filter((s) => s.evidence?.quote || s.detail || s.context).length
    },
    dev: {
      generated: (d.generatedKrt || []).length,
      adds: scoreRows(index, dAdds, 'resourceName', 'identifier'),
      suggestions: (d.suggestions || []).length,
      addSuggestions: scoreRows(index, addSuggestions(d.suggestions), 'resourceName', 'identifier'),
      withEvidence: (d.suggestions || []).filter((s) => s.evidence?.quote || s.detail || s.context).length
    }
  });
}

console.log('='.repeat(96));
console.log('GENERATED KRT — rows each pipeline ADDS beyond the author table, and whether the paper supports them');
console.log('='.repeat(96));
console.log('document                    author |      dev adds  supported |   branch adds  supported');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    `${r.name.slice(0, 26).padEnd(26)} ${String(r.authorRows).padStart(6)} |`
    + ` ${String(r.dev.adds.total).padStart(11)} ${(String(r.dev.adds.supported) + ' ' + pct(r.dev.adds.supported, r.dev.adds.total)).padStart(10)} |`
    + ` ${String(r.branch.adds.total).padStart(12)} ${(String(r.branch.adds.supported) + ' ' + pct(r.branch.adds.supported, r.branch.adds.total)).padStart(10)}`
    + (r.excluded ? '   [excluded from suggestions]' : '')
  );
}
const sum = (side, k) => rows.reduce((n, r) => n + r[side].adds[k], 0);
console.log('-'.repeat(96));
console.log(
  `${'TOTAL'.padEnd(26)} ${String(rows.reduce((n, r) => n + r.authorRows, 0)).padStart(6)} |`
  + ` ${String(sum('dev', 'total')).padStart(11)} ${(sum('dev', 'supported') + ' ' + pct(sum('dev', 'supported'), sum('dev', 'total'))).padStart(10)} |`
  + ` ${String(sum('branch', 'total')).padStart(12)} ${(sum('branch', 'supported') + ' ' + pct(sum('branch', 'supported'), sum('branch', 'total'))).padStart(10)}`
);

console.log('\n' + '='.repeat(96));
console.log('AI SUGGESTIONS — what a curator is actually asked to act on');
console.log('='.repeat(96));
console.log('document                     dev sugg (add / supported) | branch sugg (add / supported) | w/ context');
console.log('-'.repeat(96));
const usable = rows.filter((r) => !r.excluded);
for (const r of rows) {
  const mark = r.excluded ? ' EXCLUDED' : '';
  console.log(
    `${r.name.slice(0, 26).padEnd(26)}`
    + ` ${String(r.dev.suggestions).padStart(5)} (${String(r.dev.addSuggestions.total).padStart(3)} / ${pct(r.dev.addSuggestions.supported, r.dev.addSuggestions.total).padStart(4)}) |`
    + ` ${String(r.branch.suggestions).padStart(8)} (${String(r.branch.addSuggestions.total).padStart(3)} / ${pct(r.branch.addSuggestions.supported, r.branch.addSuggestions.total).padStart(4)}) |`
    + ` dev ${String(r.dev.withEvidence).padStart(3)}  br ${String(r.branch.withEvidence).padStart(3)}${mark}`
  );
}
const s = (side, k) => usable.reduce((n, r) => n + r[side].addSuggestions[k], 0);
const tot = (side) => usable.reduce((n, r) => n + r[side].suggestions, 0);
const ev = (side) => usable.reduce((n, r) => n + r[side].withEvidence, 0);
console.log('-'.repeat(96));
console.log(`TOTAL (${usable.length} usable documents)`);
console.log(`   dev    : ${tot('dev')} suggestions, ${s('dev', 'total')} add-type, ${s('dev', 'supported')} supported by the manuscript (${pct(s('dev', 'supported'), s('dev', 'total'))}), ${ev('dev')} carry context`);
console.log(`   branch : ${tot('branch')} suggestions, ${s('branch', 'total')} add-type, ${s('branch', 'supported')} supported by the manuscript (${pct(s('branch', 'supported'), s('branch', 'total'))}), ${ev('branch')} carry context`);

if (Object.keys(EXCLUDED).length) {
  console.log('\nEXCLUDED:');
  for (const [k, why] of Object.entries(EXCLUDED)) console.log(`   ${k}: ${why}`);
}
