#!/usr/bin/env node
/**
 * Fix demo-findings lab material resource types.
 *
 * Every labMaterialMentions item in src/backend/data/demo-findings/*.json
 * currently has resource_type: "Other". When a matching KRT CSV exists in
 * src/frontend/public/demo-files/<manuscriptId>.csv, walk the materials and
 * copy the correct RESOURCE TYPE from the CSV row whose RESOURCE NAME matches
 * canonical_name (case-insensitive, whitespace-normalized).
 *
 * KRT rows of type Dataset / Software/code are excluded from the lookup so a
 * stray name collision can't flip a lab material into a dataset.
 *
 * Usage:
 *   node scripts/fix-demo-materials-resource-types.js            # apply
 *   node scripts/fix-demo-materials-resource-types.js --dry-run  # report only
 */

const fs = require('fs');
const path = require('path');
const Papa = require(path.resolve(__dirname, '..', 'node_modules/papaparse'));

const DEMO_JSON_DIR = path.resolve(__dirname, '..', 'src/backend/data/demo-findings');
const DEMO_CSV_DIR = path.resolve(__dirname, '..', 'src/frontend/public/demo-files');

const EXCLUDED_CSV_TYPES = new Set(['dataset', 'code/software']);
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

/** Normalize a resource name for comparison: trim, lowercase, collapse whitespace. */
function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Load the KRT CSV for a manuscript ID (case-insensitive on the filename). */
function loadKrtCsv(manuscriptId) {
  if (!fs.existsSync(DEMO_CSV_DIR)) return null;
  const target = manuscriptId.toLowerCase() + '.csv';
  const match = fs
    .readdirSync(DEMO_CSV_DIR)
    .find((f) => f.toLowerCase() === target);
  if (!match) return null;
  // Strip BOM and parse — some CSVs in this repo use Title Case headers, some
  // UPPERCASE, some have a typo ("Additonal Information") — normalize keys
  // downstream so we don't care about exact header casing.
  let csvText = fs.readFileSync(path.join(DEMO_CSV_DIR, match), 'utf-8');
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  return parsed.data;
}

/**
 * Pull a field from a CSV row in a header-casing-tolerant way. Matches any
 * header whose normalized form equals the target (e.g. "RESOURCE NAME",
 * "Resource Name", "resource name" all work).
 */
function getField(row, target) {
  const wanted = normalize(target);
  for (const [k, v] of Object.entries(row)) {
    if (normalize(k) === wanted) return v;
  }
  return undefined;
}

/**
 * Build a lookup of normalized RESOURCE NAME → RESOURCE TYPE from a KRT CSV,
 * excluding Dataset / Code-Software rows (those are not lab materials).
 */
function buildLookup(csvRows) {
  const lookup = new Map();
  for (const row of csvRows) {
    const name = getField(row, 'RESOURCE NAME');
    const type = getField(row, 'RESOURCE TYPE');
    if (!name || !type) continue;
    if (EXCLUDED_CSV_TYPES.has(type.trim().toLowerCase())) continue;
    const key = normalize(name);
    if (!lookup.has(key)) lookup.set(key, type.trim());
  }
  return lookup;
}

/** Try to find a KRT resource type for a given material name. */
function findType(lookup, canonicalName) {
  const key = normalize(canonicalName);
  if (lookup.has(key)) return lookup.get(key);
  // Fallback: try stripping common parenthetical suffixes like "(v1.0)"
  const stripped = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped !== key && lookup.has(stripped)) return lookup.get(stripped);
  return null;
}

function main() {
  const files = fs
    .readdirSync(DEMO_JSON_DIR)
    .filter((f) => f.endsWith('-demo.json'))
    .sort();

  console.log(`Scanning ${files.length} demo-findings files${DRY_RUN ? ' (dry run)' : ''}...\n`);

  let filesTouched = 0;
  let totalMatched = 0;
  let totalMissed = 0;
  let totalSkippedNoCsv = 0;

  for (const file of files) {
    const filePath = path.join(DEMO_JSON_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const items = data?.labMaterialMentions?.items || [];
    if (items.length === 0) continue;

    const manuscriptId = data.manuscriptId;
    if (!manuscriptId) {
      console.log(`  ${file}: no manuscriptId, skipped`);
      continue;
    }

    const csvRows = loadKrtCsv(manuscriptId);
    if (!csvRows) {
      totalSkippedNoCsv += items.length;
      console.log(`  ${file}: no matching CSV for ${manuscriptId} (${items.length} items untouched)`);
      continue;
    }

    const lookup = buildLookup(csvRows);
    let matched = 0;
    let missed = 0;
    const missedNames = [];

    for (const item of items) {
      const type = findType(lookup, item.canonical_name);
      if (type) {
        if (item.resource_type !== type) {
          item.resource_type = type;
        }
        matched++;
      } else {
        missed++;
        missedNames.push(item.canonical_name);
      }
    }

    totalMatched += matched;
    totalMissed += missed;

    console.log(
      `  ${file}: matched ${matched}/${items.length} (${missed} left as 'Other')`
    );
    if (missedNames.length > 0 && missedNames.length <= 8) {
      for (const n of missedNames) console.log(`      - ${n}`);
    } else if (missedNames.length > 8) {
      for (const n of missedNames.slice(0, 5)) console.log(`      - ${n}`);
      console.log(`      … and ${missedNames.length - 5} more`);
    }

    if (!DRY_RUN && matched > 0) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      filesTouched++;
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Files updated:     ${DRY_RUN ? '(dry run — 0)' : filesTouched}`);
  console.log(`  Items matched:     ${totalMatched}`);
  console.log(`  Items not matched: ${totalMissed}`);
  console.log(`  Items skipped (no CSV): ${totalSkippedNoCsv}`);
}

main();
