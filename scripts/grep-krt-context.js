#!/usr/bin/env node
/**
 * Raw manuscript context for the KRT rows awaiting review.
 *
 * The review workbook shows the sentences the linkage matched. This shows the
 * raw text around EVERY occurrence of every term that was tried, including the
 * terms that found nothing — which is what tells a reviewer why a row failed
 * rather than just that it did. It is the batch version of
 *
 *   grep -o -n -i ".\{60\}<name>.\{60\}" tmp/batch-check/markdown/<doc>.md
 *
 * Searching is deliberately RAW and case-insensitive, over the markdown as it
 * sits on disk. The linkage searches a normalised index, so the two disagree on
 * purpose: when raw finds nothing and the linkage found something, the
 * difference IS the finding (a hyphen, a line break, a Unicode dash).
 *
 * Offline: no LM calls, no database.
 *
 * Usage:
 *   node scripts/grep-krt-context.js                    # every row awaiting review
 *   node scripts/grep-krt-context.js --all              # every row, decided or not
 *   node scripts/grep-krt-context.js --doc WH1-000282-023-org-P-2
 *   node scripts/grep-krt-context.js --find "zoo" --doc WH1-000282-023-org-P-2
 *   node scripts/grep-krt-context.js --width 90         # context either side
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GOLD = path.join(ROOT, 'tmp/krt-linkage');
const MD_DIR = path.join(ROOT, 'tmp/batch-check/markdown');
const OUT = path.join(GOLD, 'context');

const { identifiers, tokenRuns, nameParts } = require('./build-krt-linkage');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const WIDTH = Number(arg('--width', 60));
const ONLY_DOC = arg('--doc', null);
const FIND = arg('--find', null);
const ALL = process.argv.includes('--all');
const MAX_HITS = 6;
const NEEDS_REVIEW = new Set(['tokens-only', 'not-found']);

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Manual boundaries: \b counts a hyphen as one, so \bzoo\b matches "zoo-like". */
const boundary = (s) => `(?<![A-Za-z0-9])${esc(s)}(?![A-Za-z0-9])`;

/** Byte offset -> 1-based line number, via a prefix scan built once per file. */
function lineIndex(md) {
  const starts = [0];
  for (let i = 0; i < md.length; i++) if (md[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0; let hi = starts.length - 1; let r = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= off) { r = m; lo = m + 1; } else hi = m - 1; }
    return r + 1;
  };
}

function search(md, term, { whole = false } = {}) {
  const re = new RegExp(whole ? boundary(term) : esc(term), 'gi');
  const out = [];
  for (const m of md.matchAll(re)) {
    out.push(m.index);
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/** ±WIDTH characters, newlines collapsed so one hit stays on one line. */
function context(md, at, len) {
  const from = Math.max(0, at - WIDTH);
  const to = Math.min(md.length, at + len + WIDTH);
  const before = md.slice(from, at).replace(/\s+/g, ' ');
  const hit = md.slice(at, at + len).replace(/\s+/g, ' ');
  const after = md.slice(at + len, to).replace(/\s+/g, ' ');
  return `${from > 0 ? '…' : ''}${before}>>>${hit}<<<${after}${to < md.length ? '…' : ''}`;
}

/**
 * Every term worth trying for a row, in the order a human would try them.
 * Short names get whole-word treatment; a substring search for "zoo" also
 * matches "zoom", which is precisely the mistake this is meant to prevent.
 */
function termsFor(row) {
  const name = String(row.resourceName || '').trim();
  const terms = [];
  const push = (label, term, opts) => {
    if (term && term.length >= 2 && !terms.some((t) => t.term.toLowerCase() === term.toLowerCase())) {
      terms.push({ label, term, ...opts });
    }
  };

  push('name', name, { whole: name.length < 4 });
  for (const p of nameParts(name)) push('name part', p, {});
  for (const id of identifiers(row.identifier)) push('identifier', id, {});
  for (const run of tokenRuns(name).slice(0, 4)) push('token run', run, {});

  // Last resort for rows nothing else reached: every token on its own, whole
  // word. Noisy by design — a reviewer wants to see "antimycin appears 3
  // times" even when no rule would accept it as a match.
  if (row.bucket === 'not-found') {
    for (const t of name.toLowerCase().split(/[^a-z0-9+.]+/i).filter((t) => t.length >= 3)) {
      push('token (broad)', t, { whole: true });
    }
  }
  return terms;
}

function reportRow(md, toLine, row) {
  const lines = [];
  lines.push('─'.repeat(100));
  lines.push(`${row.resourceName}`);
  lines.push(`  type: ${row.resourceType || '—'}   id: ${row.identifier || '—'}   source: ${row.source || '—'}`);
  lines.push(`  case: ${row.bucket}${row.verdict ? `   verdict: ${row.verdict}` : ''}`);
  let any = false;
  for (const t of termsFor(row)) {
    const hits = search(md, t.term, t);
    if (hits.length) any = true;
    lines.push(`  ${t.label} "${t.term}"${t.whole ? ' (whole word)' : ''} — ${hits.length}${hits.length >= MAX_HITS ? '+' : ''} hit${hits.length === 1 ? '' : 's'}`);
    for (const at of hits) lines.push(`      L${String(toLine(at)).padStart(5)}  ${context(md, at, t.term.length)}`);
  }
  if (!any) lines.push('  (no term matched anywhere in the manuscript)');
  return lines.join('\n');
}

(async () => {
  if (!fs.existsSync(GOLD)) { console.error('No gold linkage — run build-krt-linkage.js first.'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  let files = fs.readdirSync(GOLD).filter((f) => f.endsWith('.json'));
  if (ONLY_DOC) files = files.filter((f) => f.startsWith(ONLY_DOC));
  if (!files.length) { console.error(`No linkage for ${ONLY_DOC || 'any document'}.`); process.exit(1); }

  let totalRows = 0;
  for (const f of files) {
    const rows = JSON.parse(fs.readFileSync(path.join(GOLD, f), 'utf-8'));
    if (!rows.length) continue;
    const doc = rows[0].document;
    const mdPath = path.join(MD_DIR, `${doc}.md`);
    if (!fs.existsSync(mdPath)) continue;
    const md = fs.readFileSync(mdPath, 'utf-8');
    const toLine = lineIndex(md);

    // --find is the ad-hoc mode: one term, straight to stdout.
    if (FIND) {
      const whole = FIND.length < 4;
      const hits = search(md, FIND, { whole });
      console.log(`\n${doc} — "${FIND}"${whole ? ' (whole word)' : ''} — ${hits.length}${hits.length >= MAX_HITS ? '+' : ''} hits`);
      for (const at of hits) console.log(`  L${String(toLine(at)).padStart(5)}  ${context(md, at, FIND.length)}`);
      continue;
    }

    const wanted = rows.filter((r) => ALL || NEEDS_REVIEW.has(r.bucket));
    if (!wanted.length) continue;
    const body = [
      `${doc}`,
      `${wanted.length} row${wanted.length === 1 ? '' : 's'}${ALL ? '' : ' awaiting review'} · markdown: ${path.relative(ROOT, mdPath)}`,
      `context: ±${WIDTH} chars · >>>match<<< · L = line in the markdown`,
      ''
    ].concat(wanted.map((r) => reportRow(md, toLine, r))).join('\n');
    fs.writeFileSync(path.join(OUT, `${doc}.txt`), `${body}\n`);
    totalRows += wanted.length;
    process.stdout.write(`  ${doc.slice(0, 30).padEnd(32)} ${String(wanted.length).padStart(4)} rows\n`);
  }

  if (!FIND) {
    console.log(`\n${totalRows} rows written to ${path.relative(ROOT, OUT)}/`);
    console.log('One .txt per document, alongside the workbook. Open both while reviewing.');
  }
})();
