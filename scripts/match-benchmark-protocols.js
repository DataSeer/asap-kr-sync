#!/usr/bin/env node

/**
 * Match Benchmark Protocols
 *
 * Reads a benchmark XLSX (with `real` and `demo` sheets) and tags every row in
 * `real` with a match label and a list of matching demo rows.
 *
 * - Each real row (Kind=Protocols) is compared by Resource Name against every
 *   row in the demo sheet (all manuscripts, all kinds).
 * - A match is classified `perfect` (normalized equality, including acronym
 *   expansion) or `partial` (normalized substring, acronym-in-tokens, or
 *   token-overlap >= 50% on the shorter side). The rules favor recall.
 * - Output: a new XLSX with `Summary` and `demo` preserved and the `real`
 *   sheet rewritten with three appended columns: Match / Match Count /
 *   Matches. Each line in Matches describes one demo hit.
 *
 * Usage:
 *   node scripts/match-benchmark-protocols.js <input.xlsx> [output.xlsx]
 *
 * Default output: <input>_matched.xlsx alongside the input.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ===================== CONFIG =====================

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at',
  'by', 'with', 'from', 'as', 'is', 'this', 'these', 'our', 'their'
]);

const TOKEN_OVERLAP_THRESHOLD = 0.5;
const MIN_SUBSTRING_LEN = 3;
const MIN_ACRONYM_LEN = 3;

// ===================== NORMALIZATION =====================

/**
 * Lowercase, replace non-alphanumerics with spaces, collapse whitespace.
 */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find an ALL-CAPS acronym inside parentheses, e.g. "(BRAIN)" -> "BRAIN".
 * Only returns the first such token with length >= MIN_ACRONYM_LEN.
 */
function extractParenAcronym(original) {
  const m = String(original || '').match(/\(([A-Z0-9]{3,})\)/);
  return m ? m[1] : null;
}

/**
 * Same as above but strips the "(ACRONYM)" substring from the name so we can
 * compare the long form alone.
 */
function stripParenAcronym(original) {
  return String(original || '').replace(/\s*\([A-Z0-9]{3,}\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(normalized) {
  return normalized.split(/\s+/).filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build all the representations we'll use to compare a name.
 */
function buildInfo(rawName) {
  const original = String(rawName || '').trim();
  const normalized = normalize(original);
  const acronym = extractParenAcronym(original);
  const withoutParensNorm = acronym ? normalize(stripParenAcronym(original)) : '';
  return {
    original,
    normalized,
    withoutParens: withoutParensNorm,
    acronym,
    tokens: tokenize(normalized)
  };
}

// ===================== MATCHING =====================

/**
 * Compare two name infos. Returns 'perfect' | 'partial' | null.
 *
 * Order: perfect checks first, partial checks second. Rules designed to lean
 * toward recall — user prefers over-matching to missing matches.
 */
function compare(a, b) {
  const aForms = [a.normalized, a.withoutParens].filter(Boolean);
  const bForms = [b.normalized, b.withoutParens].filter(Boolean);

  // Perfect: any surface form equals any other surface form
  for (const x of aForms) {
    for (const y of bForms) {
      if (x && y && x === y) return 'perfect';
    }
  }
  // Perfect: acronym matches the other side's full normalized form
  if (a.acronym) {
    const lc = a.acronym.toLowerCase();
    if (bForms.includes(lc)) return 'perfect';
  }
  if (b.acronym) {
    const lc = b.acronym.toLowerCase();
    if (aForms.includes(lc)) return 'perfect';
  }

  // Partial: substring either direction
  for (const x of aForms) {
    for (const y of bForms) {
      if (!x || !y) continue;
      if (x.length < MIN_SUBSTRING_LEN || y.length < MIN_SUBSTRING_LEN) continue;
      if (x.includes(y) || y.includes(x)) return 'partial';
    }
  }

  // Partial: acronym appears as a token on the other side
  if (a.acronym && b.tokens.includes(a.acronym.toLowerCase())) return 'partial';
  if (b.acronym && a.tokens.includes(b.acronym.toLowerCase())) return 'partial';

  // Partial: token overlap >= 50% on shorter side
  if (a.tokens.length > 0 && b.tokens.length > 0) {
    const aSet = new Set(a.tokens);
    const bSet = new Set(b.tokens);
    let inter = 0;
    for (const t of aSet) if (bSet.has(t)) inter++;
    const shorter = Math.min(aSet.size, bSet.size);
    if (shorter > 0 && inter / shorter >= TOKEN_OVERLAP_THRESHOLD) return 'partial';
  }

  return null;
}

// ===================== FORMATTING =====================

/**
 * Format one demo hit as a single line suitable for an Excel cell.
 * Hides the demo name when it trivially equals the real name (case-insensitive).
 */
function formatMatchLine(level, realName, hit) {
  const sameMs = hit.sameManuscript;
  const scope = sameMs ? 'same manuscript' : `other manuscript (${hit.demoMsId})`;
  const parts = [level, scope, hit.demoKind || 'Unknown'];

  const differs = hit.demoName && hit.demoName.toLowerCase().trim() !== String(realName || '').toLowerCase().trim();
  if (differs) parts.push(`"${hit.demoName}"`);

  return parts.join(' — ');
}

/**
 * Sort hits so the most relevant ones appear first in the cell.
 * Priority: perfect > partial, same-ms > other-ms, Protocols > other kinds.
 */
function sortHits(hits) {
  const kindRank = k => (k === 'Protocols' ? 0 : 1);
  return hits.slice().sort((x, y) => {
    const xp = x.level === 'perfect' ? 0 : 1;
    const yp = y.level === 'perfect' ? 0 : 1;
    if (xp !== yp) return xp - yp;
    const xm = x.sameManuscript ? 0 : 1;
    const ym = y.sameManuscript ? 0 : 1;
    if (xm !== ym) return xm - ym;
    const xk = kindRank(x.demoKind);
    const yk = kindRank(y.demoKind);
    if (xk !== yk) return xk - yk;
    return String(x.demoName || '').localeCompare(String(y.demoName || ''));
  });
}

// ===================== MAIN =====================

function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  if (!inputPath) {
    console.error('Usage: node scripts/match-benchmark-protocols.js <input.xlsx> [output.xlsx]');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }

  const outputPath = args[1] || inputPath.replace(/\.xlsx$/i, '_matched.xlsx');

  const wb = XLSX.readFile(inputPath);
  if (!wb.Sheets['real'] || !wb.Sheets['demo']) {
    console.error('Input must have both `real` and `demo` sheets.');
    process.exit(1);
  }

  const realRows = XLSX.utils.sheet_to_json(wb.Sheets['real'], { defval: '' });
  const demoRows = XLSX.utils.sheet_to_json(wb.Sheets['demo'], { defval: '' });

  // Pre-compute name info for every demo row
  const demoInfos = demoRows.map(r => ({
    msId: r['Manuscript ID'],
    kind: r['Kind'],
    name: r['Resource Name'],
    info: buildInfo(r['Resource Name'])
  }));

  // For every real row, find all demo hits
  let perfectCount = 0;
  let partialCount = 0;
  let noMatchCount = 0;
  let crossMsOnlyCount = 0;

  const augmented = realRows.map(realRow => {
    const realMsId = realRow['Manuscript ID'];
    const realName = realRow['Resource Name'];
    const realInfo = buildInfo(realName);

    const hits = [];
    for (const d of demoInfos) {
      const level = compare(realInfo, d.info);
      if (!level) continue;
      hits.push({
        level,
        demoMsId: d.msId,
        demoKind: d.kind,
        demoName: d.name,
        sameManuscript: d.msId === realMsId
      });
    }

    const sortedHits = sortHits(hits);

    let overall;
    if (sortedHits.some(h => h.level === 'perfect')) overall = 'perfect match';
    else if (sortedHits.length > 0) overall = 'partial match';
    else overall = 'no match';

    if (overall === 'perfect match') perfectCount++;
    else if (overall === 'partial match') partialCount++;
    else noMatchCount++;

    if (sortedHits.length > 0 && sortedHits.every(h => !h.sameManuscript)) {
      crossMsOnlyCount++;
    }

    const matchesText = sortedHits.map(h => formatMatchLine(h.level, realName, h)).join('\n');

    return {
      ...realRow,
      'Match': overall,
      'Match Count': sortedHits.length,
      'Matches': matchesText
    };
  });

  // Rebuild workbook: keep Summary + demo, rewrite real
  const outWb = XLSX.utils.book_new();

  for (const sheetName of wb.SheetNames) {
    if (sheetName === 'real') continue;
    XLSX.utils.book_append_sheet(outWb, wb.Sheets[sheetName], sheetName);
  }

  const realHeaderOrder = [
    'Manuscript ID', 'Kind', 'Resource Name', 'Resource Type',
    'Source', 'Identifier', 'New/Reuse', 'Relevance',
    'Match', 'Match Count', 'Matches'
  ];
  const realSheet = XLSX.utils.json_to_sheet(augmented, { header: realHeaderOrder });
  realSheet['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 40 }, { wch: 16 },
    { wch: 30 }, { wch: 40 }, { wch: 10 }, { wch: 10 },
    { wch: 14 }, { wch: 12 }, { wch: 80 }
  ];

  // Enable wrap-text on the Matches column so multi-line cells render well.
  // XLSX cell style property is !s / .s, but sheet-level hints live in !cols.
  // Best-effort: set wrapText per cell in the Matches column.
  const range = XLSX.utils.decode_range(realSheet['!ref']);
  const matchesColIdx = realHeaderOrder.indexOf('Matches');
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: matchesColIdx });
    const cell = realSheet[addr];
    if (cell) {
      cell.s = cell.s || {};
      cell.s.alignment = { wrapText: true, vertical: 'top' };
    }
  }

  // Re-insert the real sheet in its original position (after Summary, before demo)
  const targetIdx = wb.SheetNames.indexOf('real');
  const sheetNamesOut = outWb.SheetNames.slice();
  outWb.SheetNames.splice(Math.min(targetIdx, sheetNamesOut.length), 0, 'real');
  outWb.Sheets['real'] = realSheet;

  XLSX.writeFile(outWb, outputPath);

  // Summary
  console.log('=== Match Benchmark Protocols ===');
  console.log(`Input:  ${inputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log('');
  console.log(`Real rows processed:         ${realRows.length}`);
  console.log(`  perfect match:             ${perfectCount}`);
  console.log(`  partial match:             ${partialCount}`);
  console.log(`  no match:                  ${noMatchCount}`);
  console.log(`  matched only in other MS:  ${crossMsOnlyCount}  (candidates humans may have missed)`);
  console.log('');
  console.log(`Demo rows searched:          ${demoRows.length}`);
}

main();
