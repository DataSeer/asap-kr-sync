#!/usr/bin/env node
/**
 * Does each author KRT actually describe the manuscript beside it?
 *
 * A pair being present on disk says nothing about whether it belongs together.
 * A KRT can be a template someone never filled in, a table exported from a
 * different manuscript, or a real table for a paper whose methods section
 * happens to name almost none of it. Any of those would sit in the corpus
 * looking fine and quietly punish BOTH strategies for failing to find things
 * that were never in the text — which is exactly the measurement the comparison
 * depends on.
 *
 * So this scores every pair before the corpus is fixed, using the app's OWN
 * presence check — `presenceForRows` over `buildEvidenceIndex`. That matters
 * twice over: it is deterministic and involves no model, so it costs nothing and
 * cannot drift from run to run; and it is the same code the pipeline uses, so a
 * pair that scores badly here would score badly there for the same reasons.
 *
 * What it does NOT do is judge the pipeline. Presence asks only "does this
 * string occur in the manuscript" — a resource the paper discusses without ever
 * naming will read as absent, and that is a real property of the pair, not a
 * detector's failure.
 *
 * Needs the markdown, not the PDF. 37 of the 51 usable pairs already have one in
 * the archives; the rest would have to be converted first, which costs Modal
 * calls, so they are reported as unknown rather than assumed bad.
 *
 * Reads only. Both the manuscripts and this output are unpublished — everything
 * stays under tmp/, which is gitignored.
 *
 *   node scripts/dev/check-corpus-presence.js [--min 60] [--json tmp/corpus/presence.json]
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
const { presenceForRows } = require(path.join(ROOT, 'src/backend/services/krt-grounding/krt-grounding.service'));
const { buildEvidenceIndex } = require(path.join(ROOT, 'src/backend/services/pdf-analysis/evidence.service'));

const INVENTORY = path.join(ROOT, 'tmp/corpus/inventory.json');
const ARCHIVES = ['tmp/instance-save-prod', 'tmp/instance-save-dev'].map((d) => path.join(ROOT, d));

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Every markdown we already have, keyed by the SHA of the PDF it came from.
 *
 * Keyed by content rather than by name because the same manuscript reaches us
 * as a demo file and as several dev uploads under different ids — the demo copy
 * has no markdown, one of the dev copies usually does, and they are the same
 * document.
 */
function markdownByPdfSha() {
  const out = new Map();
  for (const dir of ARCHIVES) {
    if (!fs.existsSync(dir)) continue;
    for (const submission of fs.readdirSync(dir)) {
      const base = path.join(dir, submission);
      if (!fs.statSync(base).isDirectory()) continue;
      for (const round of fs.readdirSync(base).filter((d) => /^round-\d+$/.test(d))) {
        const pdfDir = path.join(base, round, 'pdf');
        const mdDir = path.join(base, round, 'markdown');
        if (!fs.existsSync(pdfDir) || !fs.existsSync(mdDir)) continue;
        const pdf = fs.readdirSync(pdfDir).find((f) => f.toLowerCase().endsWith('.pdf'));
        const md = fs.readdirSync(mdDir).find((f) => f.endsWith('.md'));
        if (!pdf || !md) continue;
        const hash = sha256(path.join(pdfDir, pdf));
        if (!out.has(hash)) out.set(hash, path.join(mdDir, md));
      }
    }
  }
  return out;
}

/** Author rows in the shape presenceForRows expects. */
async function loadAuthorRows(krtFile) {
  const ext = path.extname(krtFile).toLowerCase();
  const mime = ext === '.csv'
    ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const rows = await parserService.parseFile(fs.readFileSync(krtFile), mime, path.basename(krtFile));
  const value = (row, name) => String(row?.[name] ?? '').trim();

  return rows
    .filter((r) => value(r, 'RESOURCE NAME') || value(r, 'IDENTIFIER'))
    .map((r, i) => ({
      id: `row-${i}`,
      resourceType: value(r, 'RESOURCE TYPE'),
      resourceName: value(r, 'RESOURCE NAME'),
      identifier: value(r, 'IDENTIFIER'),
      source: value(r, 'SOURCE')
    }));
}

function scorePair(markdownFile, authorRows) {
  const index = buildEvidenceIndex(fs.readFileSync(markdownFile, 'utf-8'));
  const presence = presenceForRows(index, authorRows);

  let found = 0;
  const byVia = {};
  for (const row of authorRows) {
    const verdict = presence.get(row.id);
    if (verdict?.found) {
      found += 1;
      const via = verdict.via || 'unknown';
      byVia[via] = (byVia[via] || 0) + 1;
    }
  }
  return {
    rows: authorRows.length,
    found,
    pct: authorRows.length ? Math.round((found / authorRows.length) * 100) : 0,
    byVia
  };
}

async function main() {
  if (!fs.existsSync(INVENTORY)) {
    console.error('Run scripts/dev/inventory-corpus.js --json tmp/corpus/inventory.json first.');
    process.exit(1);
  }
  const minAt = process.argv.indexOf('--min');
  const MIN = minAt !== -1 ? Number(process.argv[minAt + 1]) : 60;
  const jsonAt = process.argv.indexOf('--json') !== -1
    ? process.argv[process.argv.indexOf('--json') + 1]
    : null;

  const { usable } = JSON.parse(fs.readFileSync(INVENTORY, 'utf-8'));
  const markdown = markdownByPdfSha();

  const scored = [];
  const unknown = [];
  for (const entry of usable) {
    const md = markdown.get(entry.pdfSha);
    if (!md) { unknown.push(entry); continue; }
    try {
      const rows = await loadAuthorRows(entry.krt);
      scored.push({ ...entry, presence: scorePair(md, rows), markdown: path.relative(ROOT, md) });
    } catch (err) {
      unknown.push({ ...entry, error: err.message.slice(0, 100) });
    }
  }

  scored.sort((a, b) => b.presence.pct - a.presence.pct);

  console.log('\n── how much of each author KRT is findable in its manuscript ─────────');
  console.log(' pct   found/rows  source  manuscript');
  for (const s of scored) {
    const flag = s.presence.pct < MIN ? '  <-- below threshold' : '';
    console.log(
      String(s.presence.pct).padStart(4) + '%',
      `${String(s.presence.found).padStart(4)}/${String(s.presence.rows).padEnd(4)}`,
      ' ' + s.source.padEnd(6),
      s.manuscriptId.slice(0, 40) + flag
    );
  }

  const pass = scored.filter((s) => s.presence.pct >= MIN);
  const fail = scored.filter((s) => s.presence.pct < MIN);
  const totalRows = scored.reduce((n, s) => n + s.presence.rows, 0);
  const totalFound = scored.reduce((n, s) => n + s.presence.found, 0);

  console.log(`\nscored          ${scored.length} pairs, ${totalRows} author rows`);
  console.log(`overall         ${Math.round((totalFound / totalRows) * 100)}% of rows findable in their manuscript`);
  console.log(`at or above ${MIN}%  ${pass.length}`);
  console.log(`below           ${fail.length}`);
  console.log(`not scored      ${unknown.length}  (no markdown yet — needs a conversion first)`);

  if (unknown.length) {
    console.log('\n── not scored ────────────────────────────────────────────────────────');
    for (const u of unknown) {
      console.log('  ' + (u.source || '?').padEnd(6), u.manuscriptId.slice(0, 44), u.error ? `(${u.error})` : '');
    }
  }

  if (jsonAt) {
    fs.mkdirSync(path.dirname(jsonAt), { recursive: true });
    fs.writeFileSync(jsonAt, JSON.stringify({ min: MIN, scored, unknown }, null, 2));
    console.log(`\nwritten to ${path.relative(ROOT, jsonAt)}`);
    console.log('Unpublished manuscripts — keep this under tmp/, never commit it.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
