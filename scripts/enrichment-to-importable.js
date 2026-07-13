#!/usr/bin/env node
/**
 * Convert a raw EnrichmentListEntry DB dump into the shape the admin UI CSV
 * importer accepts.
 *
 * The db-dump (tmp/identifiers/db-dump/enrichment-<category>.csv) leaves
 * `resourceType` and `resourceName` blank — the resource name only exists in the
 * `tokens` column, and many rows are pure identifier-index entries with no name
 * at all. But the importer (EnrichmentListView.vue + importEntries controller)
 * drops every row whose resourceName OR resourceType is empty, so a raw dump
 * imports as "No valid entries found".
 *
 * This transform, per row:
 *   - resourceName ← first non-empty of [tokens[0], first identifier value, source]
 *   - resourceType ← existing value, else inferred from RRID sub-prefix
 *     (materials only), else a per-category default
 *   - rows with no usable name/identifier/source are dropped (they carry no
 *     information the UI can key on)
 *   - rows are routed to the correct category file by identifier: an
 *     `RRID:SCR_` (SciCrunch software registry) id always belongs in the
 *     software list, even if the dump filed it under materials/datasets
 *
 * Writes in place with a `.bak` (never clobbering an existing .bak, so the
 * pristine original from an earlier cleanup pass is preserved). LF newlines.
 *
 * Usage: node scripts/enrichment-to-importable.js [--dir <path>] [--dry]
 */

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const argv = process.argv.slice(2);
const getArg = (n, d) => { const i = argv.indexOf(n); return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : d; };
const DIR = path.resolve(getArg('--dir', path.join(__dirname, '../tmp/identifiers/db-dump')));
const DRY = argv.includes('--dry');

const CATEGORY_TYPE = { software: 'Software/code', datasets: 'Dataset', protocols: 'Protocol', materials: 'Other' };
const COLUMNS = ['resourceType', 'resourceName', 'source', 'identifier', 'newReuse', 'additionalInformation', 'suggestedEntity', 'tokens'];
const MAX_NAME = 1000;

function firstToken(raw) {
  try { const a = JSON.parse(String(raw || '[]')); return Array.isArray(a) ? (a.find((x) => String(x || '').trim()) || '') : ''; }
  catch { return ''; }
}
const firstIdentifier = (idField) => String(idField || '').split(/\s*;\s*/).map((s) => s.trim()).find(Boolean) || '';

// resourceType is finer than category. The dump has none, so infer RRID sub-types
// for the mixed materials list; every other list is single-type per category.
function inferType(category, identifier) {
  if (category === 'materials') {
    const id = String(identifier || '');
    if (/RRID:\s*AB[_-]/i.test(id)) return 'Antibody';
    if (/RRID:\s*CVCL[_-]/i.test(id)) return 'Experimental model: Cell line';
    if (/RRID:\s*SCR[_-]/i.test(id)) return 'Software/code';
    if (/RRID:\s*Addgene[_-]/i.test(id)) return 'Recombinant DNA';
  }
  return CATEGORY_TYPE[category] || 'Other';
}

const isSoftwareRrid = (identifier) => /RRID:\s*SCR[_-]/i.test(String(identifier || ''));

// The category file a row belongs in, by identifier — independent of which dump
// file it arrived in. SCR ids are always software.
const routeCategory = (sourceCategory, identifier) => (isSoftwareRrid(identifier) ? 'software' : sourceCategory);

/**
 * Read one dump file and push its reshaped rows into `outputs`, keyed by the
 * category each row actually belongs in (may differ from `sourceCategory`).
 * Returns stats for the source file.
 */
function ingest(sourceCategory, file, outputs) {
  const rows = Papa.parse(fs.readFileSync(file, 'utf-8'), { header: true, skipEmptyLines: true }).data;
  let dropped = 0, rerouted = 0;

  for (const r of rows) {
    const name = (String(r.resourceName || '').trim())
      || firstToken(r.tokens)
      || firstIdentifier(r.identifier)
      || String(r.source || '').trim();
    if (!name) { dropped++; continue; }
    const target = routeCategory(sourceCategory, r.identifier);
    if (target !== sourceCategory) rerouted++;
    // SCR ids are always software — force the type even if the dump filed them
    // elsewhere with a stale type. Otherwise honour any existing/inferred type.
    const resourceType = isSoftwareRrid(r.identifier)
      ? 'Software/code'
      : (String(r.resourceType || '').trim() || inferType(sourceCategory, r.identifier));
    (outputs[target] = outputs[target] || []).push({
      resourceType,
      resourceName: name.slice(0, MAX_NAME),
      source: r.source || '',
      identifier: r.identifier || '',
      newReuse: r.newReuse || '',
      additionalInformation: r.additionalInformation || '',
      suggestedEntity: r.suggestedEntity || '',
      tokens: r.tokens || '[]'
    });
  }
  return { in: rows.length, dropped, rerouted };
}

// ── main ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(DIR)) { console.error(`Directory not found: ${DIR}`); process.exit(1); }
const files = fs.readdirSync(DIR).filter((f) => /^enrichment-.*\.csv$/i.test(f)).sort();
if (!files.length) { console.error(`No enrichment-*.csv in ${DIR}`); process.exit(1); }

console.log(`Converting DB dump → UI-importable shape — ${DIR}${DRY ? '  (dry run)' : ''}\n`);

// Read every file first (routing moves rows across files), then write.
const outputs = {};
for (const f of files) {
  const category = f.replace(/^enrichment-|\.csv$/gi, '');
  const s = ingest(category, path.join(DIR, f), outputs);
  console.log(`■ ${f}: ${s.in} rows → dropped ${s.dropped} nameless${s.rerouted ? `, rerouted ${s.rerouted} to software` : ''}`);
}

console.log('');
for (const f of files) {
  const category = f.replace(/^enrichment-|\.csv$/gi, '');
  const out = outputs[category] || [];
  const typeCounts = {};
  for (const r of out) typeCounts[r.resourceType] = (typeCounts[r.resourceType] || 0) + 1;
  const types = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(', ');
  console.log(`→ ${f}: ${out.length} importable rows`);
  console.log(`    resourceType: ${types}`);
  if (!DRY) {
    const file = path.join(DIR, f);
    const bak = file + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    fs.writeFileSync(file, Papa.unparse(out, { columns: COLUMNS, newline: '\n' }) + '\n');
  }
}
if (DRY) console.log('\n(dry run — no files written)');
