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
const CONVERTED_DIR = path.join(ROOT, 'tmp/corpus/markdown');

/** Inventory paths are repo-relative so they resolve on the host and in the container. */
const inRepo = (p) => (p && !path.isAbsolute(p) ? path.join(ROOT, p) : p);

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

        // Pair by NAME, and map EVERY pdf in the round rather than the first.
        // A round can hold two manuscripts, and taking one of each would either
        // skip the second entirely — JJ1_000520_004 read as "never converted"
        // while its markdown sat right there — or, worse, hand one manuscript's
        // text to the other's table and score it as a bad pair.
        const pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
        const mds = fs.readdirSync(mdDir).filter((f) => f.endsWith('.md'));
        const stem = (f) => f.replace(/\.[^.]+$/, '').toLowerCase();

        for (const pdf of pdfs) {
          const md = mds.find((m) => stem(m) === stem(pdf))
            // One of each is unambiguous; the archives predate this convention.
            || (pdfs.length === 1 && mds.length === 1 ? mds[0] : null);
          if (!md) continue;
          const hash = sha256(path.join(pdfDir, pdf));
          if (!out.has(hash)) out.set(hash, path.join(mdDir, md));
        }
      }
    }
  }
  // Anything convert-corpus-markdown.js produced, named by the PDF's hash.
  if (fs.existsSync(CONVERTED_DIR)) {
    for (const f of fs.readdirSync(CONVERTED_DIR).filter((f) => f.endsWith('.md'))) {
      const hash = path.basename(f, '.md');
      if (!out.has(hash)) out.set(hash, path.join(CONVERTED_DIR, f));
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

/**
 * Score one pair, and separate the two very different reasons a row goes
 * unfound.
 *
 *   ALIAS      the manuscript carries the identifier but never the author's
 *              wording. The resource IS discussed; the table names it something
 *              else. These are the rows worth keeping and pairing by hand —
 *              they are the hard case the pipeline exists to handle, and a
 *              corpus of only literal matches would never exercise it.
 *
 *   ABSENT     neither the name nor any identifier occurs. Could still be an
 *              alias whose identifier the paper never prints, or a row about
 *              something the manuscript genuinely does not mention.
 *
 * `presenceForRows` reports viaName and viaIdentifier separately rather than
 * collapsing them, which is what makes the distinction available at all.
 */
function scorePair(markdownFile, authorRows) {
  const index = buildEvidenceIndex(fs.readFileSync(markdownFile, 'utf-8'));
  const presence = presenceForRows(index, authorRows);

  let found = 0;
  let alias = 0;          // identifier present, author's name absent
  let nameOnly = 0;       // named in the paper, identifier not printed
  let both = 0;
  let absent = 0;
  let absentWithIdentifier = 0;

  for (const row of authorRows) {
    const v = presence.get(row.id) || {};
    if (v.found) {
      found += 1;
      if (v.viaIdentifier && !v.viaName) alias += 1;
      else if (v.viaName && !v.viaIdentifier) nameOnly += 1;
      else both += 1;
    } else {
      absent += 1;
      if (String(row.identifier || '').trim()) absentWithIdentifier += 1;
    }
  }

  const rows = authorRows.length;
  return {
    rows,
    found,
    pct: rows ? Math.round((found / rows) * 100) : 0,
    alias,
    nameOnly,
    both,
    absent,
    absentWithIdentifier,
    // How much of what IS findable was found only through the identifier. A
    // high share means the author's naming and the paper's diverge — the
    // signature of a table worth pairing by hand rather than discarding.
    aliasShare: found ? Math.round((alias / found) * 100) : 0
  };
}

/**
 * Is this KRT actually about some OTHER manuscript?
 *
 * A low score has two very different causes and the number alone cannot tell
 * them apart: the table may describe this paper in different words, or it may
 * belong to a different paper entirely. The second is settled by evidence —
 * score the table against every manuscript we hold and see where it fits best.
 * A table that scores far higher elsewhere is mispaired; one that scores badly
 * everywhere is simply a hard table.
 *
 * This already caught one: HU1_000350_034's manuscript had been paired with
 * JJ1_000520_004's table because a round held two PDFs.
 *
 * Cheap — string matching, no model — but quadratic, so it runs only for the
 * pairs that scored below the threshold.
 */
function findBetterHome(authorRows, ownSha, markdownBySha, ownPct) {
  let best = null;
  for (const [sha, file] of markdownBySha) {
    if (sha === ownSha) continue;
    const score = scorePair(file, authorRows);
    if (!best || score.pct > best.pct) best = { sha, pct: score.pct, file };
  }
  // Only interesting when it is a big, unambiguous improvement. Two manuscripts
  // from one lab share boilerplate, so a few points either way means nothing.
  return best && best.pct >= ownPct + 25 ? best : null;
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
      const rows = await loadAuthorRows(inRepo(entry.krt));
      scored.push({ ...entry, presence: scorePair(md, rows), markdown: path.relative(ROOT, md) });
    } catch (err) {
      unknown.push({ ...entry, error: err.message.slice(0, 100) });
    }
  }

  scored.sort((a, b) => b.presence.pct - a.presence.pct);

  console.log('\n── how much of each author KRT is findable in its manuscript ─────────');
  console.log(' pct   found/rows  alias  both  name  absent  source  manuscript');
  for (const s of scored) {
    const p = s.presence;
    const flag = p.pct < MIN ? '  <-- below' : '';
    console.log(
      String(p.pct).padStart(4) + '%',
      `${String(p.found).padStart(4)}/${String(p.rows).padEnd(4)}`,
      String(p.alias).padStart(6),
      String(p.both).padStart(5),
      String(p.nameOnly).padStart(5),
      String(p.absent).padStart(7),
      '  ' + s.source.padEnd(6),
      s.manuscriptId.slice(0, 34) + flag
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

  if (process.argv.includes('--tiers')) {
    // Three ways a pair can be worth having, and one way it is not.
    //
    // The split matters because a low score is not a verdict. A table whose
    // resources ARE in the manuscript under different wording is the hard case
    // the pipeline exists for — worth keeping once its rows are paired to their
    // sentences by hand. A table with nothing to anchor on is not.
    //
    // `alias` rows already have their anchor: the identifier is in the text, so
    // a human pairing them has somewhere to start. `absentWithIdentifier` rows
    // have an identifier the manuscript never prints — pairable, but only by
    // reading for meaning. Rows with neither are the ones nothing can rescue.
    const tierOf = (s) => {
      const p = s.presence;
      if (p.pct >= MIN) return 'usable';
      const anchored = p.alias + p.absentWithIdentifier;
      return anchored / p.rows >= 0.4 ? 'pair-by-hand' : 'weak';
    };

    const tiers = { usable: [], 'pair-by-hand': [], weak: [] };
    for (const s of scored) tiers[tierOf(s)].push(s);

    const describe = {
      usable: 'directly usable — string matching already finds most rows',
      'pair-by-hand': 'alias-heavy — the resources are there under other names; worth pairing manually',
      weak: 'little to anchor on — most rows have neither a matching name nor an identifier in the text'
    };

    for (const [tier, list] of Object.entries(tiers)) {
      console.log(`\n── ${tier} (${list.length}) — ${describe[tier]} ─────`);
      console.log(' pct  rows  alias  anchored  source  manuscript');
      for (const s of list) {
        const p = s.presence;
        console.log(
          String(p.pct).padStart(4) + '%',
          String(p.rows).padStart(5),
          String(p.alias).padStart(6),
          String(p.alias + p.absentWithIdentifier).padStart(9),
          '  ' + s.source.padEnd(6),
          s.manuscriptId.slice(0, 38)
        );
      }
    }
    const rows = (t) => tiers[t].reduce((n, s) => n + s.presence.rows, 0);
    console.log(`\nusable ${tiers.usable.length} pairs / ${rows('usable')} rows`
      + `   pair-by-hand ${tiers['pair-by-hand'].length} / ${rows('pair-by-hand')}`
      + `   weak ${tiers.weak.length} / ${rows('weak')}`);
  }

  const crossCheck = process.argv.includes('--cross-check');
  if (crossCheck) {
    const suspects = scored.filter((s) => s.presence.pct < MIN);
    console.log(`\n── cross-checking ${suspects.length} low pairs against every other manuscript ──`);
    let mispaired = 0;
    for (const s of suspects) {
      const rows = await loadAuthorRows(inRepo(s.krt));
      const better = findBetterHome(rows, s.pdfSha, markdown, s.presence.pct);
      if (better) {
        mispaired += 1;
        const owner = [...markdown.entries()].find(([sha]) => sha === better.sha);
        console.log(`  MISPAIRED  ${s.manuscriptId.slice(0, 34)}`);
        console.log(`             scores ${s.presence.pct}% here, ${better.pct}% against ${path.basename(owner[1])}`);
        s.betterHome = { pct: better.pct, markdown: path.relative(ROOT, better.file) };
      }
    }
    console.log(mispaired
      ? `\n  ${mispaired} of ${suspects.length} low pairs belong to a different manuscript.`
      : '\n  None of them fits another manuscript better — these are hard tables, not mispairings.');
  }

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
