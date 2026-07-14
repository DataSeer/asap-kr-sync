#!/usr/bin/env node
/**
 * Enrichment-list quality report for the Identifier Detection module.
 *
 * The identifier module scans the manuscript for identifiers and matches them
 * against a curated index built from these enrichment lists. A BAD list entry
 * → a confident WRONG suggestion (worse than a miss). This report reuses the
 * app's real keying logic (extractIdentifierTokens + the pid fallback, exactly
 * as known-identifier-index.buildIndex does) to flag the entries that will
 * actually misfire — without you hand-checking tens of thousands of rows.
 *
 * The index is FIRST-WINS per normalized key, so the core risk is a GENERIC key
 * that many DISTINCT resources produce (e.g. `https://doi.org` → key `url::org`):
 * any bare mention then gets attributed to one arbitrary resource. This report
 * ranks by that ambiguity.
 *
 * Report-only (no writes). Buckets, counts, and the worst offending keys per
 * list. A --fix mode (split multi-value cells, drop the over-matchers) can be
 * added once you've seen the numbers.
 *
 * Usage:
 *   node scripts/check-enrichment.js [--dir DIR] [--threshold N] [--json]
 *     --dir DIR      directory of enrichment-*.csv (default: tmp/identifiers/db-dump)
 *     --threshold N  a key shared by >= N distinct resources is "over-matching" (default 5)
 *     --json         machine-readable output
 */

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { extractIdentifierTokens, normalizeRawValue } = require('../src/backend/services/pdf-analysis/identifier-normalize.service');
const { isPidLike } = require('../src/backend/services/identifier-detection/known-identifier-index.service');

const argv = process.argv.slice(2);
const getArg = (n, d) => { const i = argv.indexOf(n); return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : d; };
const DIR = path.resolve(getArg('--dir', path.join(__dirname, '../tmp/identifiers/db-dump')));
const THRESHOLD = Math.max(2, parseInt(getArg('--threshold', '5'), 10) || 5);
const JSON_OUT = argv.includes('--json');
const FIX = argv.includes('--fix');

// Mirror known-identifier-index.buildIndex's byIdentifier path: which keys would
// THIS entry's identifier field produce? (typed tokens, else a pid fallback.)
function keysFor(idField) {
  if (!idField || !String(idField).trim()) return [];
  const tokens = extractIdentifierTokens(idField);
  const keys = [];
  for (const tok of tokens) {
    const c = tok.indexOf(':');
    if (c < 0) continue;
    const type = tok.slice(0, c);
    if (type === 'catalog') continue; // catalog path is vendor-gated at scan time
    keys.push(`${type}::${tok.slice(c + 1)}`);
  }
  if (keys.length === 0) {
    const opaque = normalizeRawValue(idField);
    if (isPidLike(opaque) || isPidLike(String(idField).trim())) keys.push(`pid::${opaque.toLowerCase()}`);
  }
  return keys;
}

// A bare-host URL key (no path) matches ANY bare mention of that host (a URL
// WITH a path — url::github.com/user/repo — is specific and safe). But not all
// bare hosts are equally risky:
//   junk     — truncated/malformed ("org", "dx", "10.528", bare TLD): always drop.
//   generic  — an aggregator/common host (doi.org, core.ac.uk, ncbi…): over-matches.
//   homepage — a specific tool/db domain (slicer.org, afni.nimh.nih.gov): usually
//              a legitimate identifier, low over-match risk — flag for review only.
const isBareHostUrl = (key) => key.startsWith('url::') && !key.slice(5).includes('/');
const GENERIC_HOSTS = new Set([
  'doi.org', 'dx.doi.org', 'core.ac.uk', 'n2t.net', 'ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov',
  'ftp.ncbi.nih.gov', 'ebi.ac.uk', 'www.ebi.ac.uk', 'github.com', 'gitlab.com', 'bitbucket.org',
  'figshare.com', 'zenodo.org', 'datadryad.org', 'osf.io', 'science.org', 'nature.com',
  'sciencedirect.com', 'springer.com', 'wiley.com', 'biorxiv.org', 'sourceforge.net',
  'protocols.io', 'bio-protocol.org', 'addgene.org', 'google.com', 'youtube.com'
]);
function classifyHost(host) {
  const h = String(host).toLowerCase();
  if (h.length <= 3 || !h.includes('.')) return 'junk';
  if (/^10\./.test(h) || /^dx(\.doi)?$/.test(h)) return 'junk';            // truncated DOI
  if (/^(org|com|net|gov|edu|io|co|uk|ac|de|fr|cn|jp)(\.[a-z]{2})?$/.test(h)) return 'junk'; // bare TLD
  return GENERIC_HOSTS.has(h) ? 'generic' : 'homepage';
}

function analyzeList(name, file) {
  const rows = Papa.parse(fs.readFileSync(file, 'utf-8'), { header: true, skipEmptyLines: true }).data;
  const idCol = Object.keys(rows[0] || {}).find(k => /^identifier$/i.test(k)) || 'identifier';
  const nameCol = Object.keys(rows[0] || {}).find(k => /resourcename/i.test(k)) || 'resourceName';

  const keyToNames = new Map();      // key → Set(resourceName) — collision/ambiguity
  const bareHostToNames = new Map(); // bare host → Set(resourceName) — genericness
  const rowKeys = [];
  let empty = 0, inactive = 0, multiValue = 0;

  for (const r of rows) {
    const idField = String(r[idCol] || '').trim();
    if (!idField) { empty++; rowKeys.push([]); continue; }
    const keys = keysFor(idField);
    rowKeys.push(keys);
    if (keys.length === 0) inactive++;      // text present but no indexable identifier (dead weight)
    if (keys.length >= 3) multiValue++;      // blob packing many identifiers
    const rn = String(r[nameCol] || '').trim().toLowerCase() || '(no name)';
    for (const k of keys) {
      if (!keyToNames.has(k)) keyToNames.set(k, new Set());
      keyToNames.get(k).add(rn);
      if (isBareHostUrl(k)) {
        const host = k.slice(5);
        if (!bareHostToNames.has(host)) bareHostToNames.set(host, new Set());
        bareHostToNames.get(host).add(rn);
      }
    }
  }

  // Classify each bare host. CRITICAL = junk or generic; homepage = review-only.
  const hostClass = {};
  for (const host of bareHostToNames.keys()) hostClass[host] = classifyHost(host);
  const collisionKeys = new Set([...keyToNames.entries()].filter(([k, n]) => n.size >= THRESHOLD && !isBareHostUrl(k)).map(([k]) => k));

  let critJunk = 0, critGeneric = 0, review = 0, criticalCollision = 0, critical = 0;
  for (const keys of rowKeys) {
    const bareHosts = keys.filter(isBareHostUrl).map(k => k.slice(5));
    const isJunk = bareHosts.some(h => hostClass[h] === 'junk');
    const isGeneric = bareHosts.some(h => hostClass[h] === 'generic');
    const isReview = !isJunk && !isGeneric && bareHosts.some(h => hostClass[h] === 'homepage');
    const coll = keys.some(k => collisionKeys.has(k));
    if (isJunk) critJunk++;
    if (isGeneric) critGeneric++;
    if (isReview) review++;
    if (coll) criticalCollision++;
    if (isJunk || isGeneric || coll) critical++;
  }

  const hostList = (cls) => [...bareHostToNames.keys()].filter(h => hostClass[h] === cls).slice(0, 12);

  return {
    list: name, rows: rows.length, empty, inactive, active: rows.length - empty - inactive, multiValue,
    criticalEntries: critical, critJunk, critGeneric, reviewHomepage: review, criticalCollision,
    junkHosts: hostList('junk'), genericHosts: hostList('generic'),
    topCollisions: [...keyToNames.entries()].filter(([k, n]) => n.size >= THRESHOLD && !isBareHostUrl(k)).map(([key, n]) => ({ key, resources: n.size })).sort((a, b) => b.resources - a.resources).slice(0, 8)
  };
}

// True when a single identifier sub-value collapses to a junk/generic bare-host key.
function isCriticalSub(sub) {
  return keysFor(sub).some(k => isBareHostUrl(k) && ['junk', 'generic'].includes(classifyHost(k.slice(5))));
}

// Remove only the junk/generic bare-host sub-values from an identifier field, keeping
// any legitimate identifiers in the same cell. A blanked cell still matches by name/catalog.
function fixIdentifierField(idField) {
  const orig = String(idField || '');
  if (!orig.trim()) return { value: orig, changed: false };
  const parts = orig.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return isCriticalSub(orig) ? { value: '', changed: true } : { value: orig, changed: false };
  const kept = parts.filter((p) => !isCriticalSub(p));
  return kept.length === parts.length ? { value: orig, changed: false } : { value: kept.join(' ; '), changed: true };
}

function fixList(file) {
  const parsed = Papa.parse(fs.readFileSync(file, 'utf-8'), { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields || [];
  const idCol = fields.find((k) => /^identifier$/i.test(k)) || 'identifier';
  let changed = 0;
  for (const r of parsed.data) {
    const { value, changed: ch } = fixIdentifierField(r[idCol]);
    if (ch) { r[idCol] = value; changed++; }
  }
  if (changed) {
    fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, Papa.unparse(parsed.data, { columns: fields, newline: '\n' }) + '\n');
  }
  return changed;
}

// ── main ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(DIR)) { console.error(`Directory not found: ${DIR}`); process.exit(1); }
const files = fs.readdirSync(DIR).filter(f => /^enrichment-.*\.csv$/i.test(f)).sort();
if (!files.length) { console.error(`No enrichment-*.csv in ${DIR}`); process.exit(1); }

if (FIX) {
  console.log(`Cleaning CRITICAL (junk/generic bare-host) identifiers — ${DIR}\n`);
  let total = 0;
  for (const f of files) {
    const n = fixList(path.join(DIR, f));
    total += n;
    console.log(`  ${f}: ${n} entr${n === 1 ? 'y' : 'ies'} cleaned${n ? ' (.bak written)' : ''}`);
  }
  console.log(`\nTotal: ${total} identifier${total === 1 ? '' : 's'} blanked/trimmed. Re-running report on cleaned data:\n`);
}

const reports = files.map(f => analyzeList(f.replace(/^enrichment-|\.csv$/gi, ''), path.join(DIR, f)));

if (JSON_OUT) { console.log(JSON.stringify({ dir: DIR, threshold: THRESHOLD, reports }, null, 2)); process.exit(0); }

console.log(`Enrichment quality report — ${DIR}`);
console.log(`(a key shared by >= ${THRESHOLD} distinct resources is flagged as over-matching)\n`);
const tot = { rows: 0, active: 0, inactive: 0, empty: 0, multiValue: 0, criticalEntries: 0, critJunk: 0, critGeneric: 0, reviewHomepage: 0, criticalCollision: 0 };
for (const r of reports) {
  for (const k of Object.keys(tot)) tot[k] += r[k] || 0;
  console.log(`■ ${r.list.toUpperCase()} — ${r.rows} rows`);
  console.log(`    active: ${r.active}   |   inactive/dead: ${r.inactive}   |   empty id: ${r.empty}   |   multi-value cells: ${r.multiValue}`);
  console.log(`    CRITICAL (fix): ${r.criticalEntries}  = junk hosts ${r.critJunk} + generic hosts ${r.critGeneric}` + (r.criticalCollision ? ` + collisions ${r.criticalCollision}` : ''));
  console.log(`    REVIEW (specific homepages, likely OK): ${r.reviewHomepage}`);
  if (r.junkHosts.length) console.log(`      junk hosts e.g.: ${r.junkHosts.join(', ')}`);
  if (r.genericHosts.length) console.log(`      generic hosts e.g.: ${r.genericHosts.join(', ')}`);
  if (r.topCollisions.length) { console.log(`      collision keys (>= ${THRESHOLD} resources):`); r.topCollisions.forEach(o => console.log(`        ${String(o.resources).padStart(4)}  ${o.key}`)); }
  console.log('');
}
console.log('─'.repeat(64));
console.log(`TOTAL — ${tot.rows} rows across ${reports.length} lists`);
console.log(`  active: ${tot.active}   inactive/dead: ${tot.inactive}   empty: ${tot.empty}   multi-value cells: ${tot.multiValue}`);
console.log(`  CRITICAL (should fix/drop): ${tot.criticalEntries} (${(100 * tot.criticalEntries / tot.rows).toFixed(1)}%) = junk ${tot.critJunk} + generic ${tot.critGeneric} + collisions ${tot.criticalCollision}`);
console.log(`  REVIEW (specific homepages, probably keep): ${tot.reviewHomepage}`);
console.log(`\nHarmless (ignore): ${tot.inactive} dead + ${tot.empty} empty entries never produce a match.`);
