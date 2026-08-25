#!/usr/bin/env node
/**
 * Convert every corpus PDF that has no markdown yet.
 *
 * Screening a pair needs the manuscript as text, and 47 of the 108 distinct
 * manuscripts have never been converted — including most of the curated demo
 * files, which ship as PDF only. They are excluded from the corpus purely for
 * want of a conversion, and "we never checked" is not evidence of being fine.
 *
 * This calls `convertToMarkdown(buffer, fileName)` directly. That function takes
 * a buffer and returns text: no submission is created, nothing is written to the
 * database or to S3, and no language model is involved. The only cost is the
 * conversion service itself, which is the cheap end of the pipeline.
 *
 * SEQUENTIAL, with a stagger, on purpose. Five concurrent conversions is what
 * made Modal/Docling return `socket hang up` during the August verification
 * runs; staggering by 75-90s produced no failures at all across two batches.
 * Wall clock is not the constraint here — a failed batch is.
 *
 * Ordered so the manuscripts that HAVE an author KRT convert first: they are the
 * ones a corpus can be built from, and an interrupted run should leave those
 * done rather than a pile of manuscripts nothing can be scored against.
 *
 * Output goes to tmp/corpus/markdown/<pdf-sha>.md, keyed by content hash so it
 * joins the inventory the same way everything else does. Already-converted PDFs
 * are skipped, so the script is safe to re-run after an interruption.
 *
 * The manuscripts are unpublished. Everything stays under tmp/, which is
 * gitignored.
 *
 *   node scripts/dev/convert-corpus-markdown.js [--limit N] [--stagger 80] [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '../..');
const { convertToMarkdown } = require(path.join(ROOT, 'src/backend/services/pdf/pdf-markdown-client.service'));
const markdownConfig = require(path.join(ROOT, 'src/backend/config/pdf-markdown-api'));

const INVENTORY = path.join(ROOT, 'tmp/corpus/inventory.json');
const OUT_DIR = path.join(ROOT, 'tmp/corpus/markdown');
const ARCHIVES = ['tmp/instance-save-prod', 'tmp/instance-save-dev'].map((d) => path.join(ROOT, d));

/** Inventory paths are repo-relative so they resolve on the host and in the container. */
const inRepo = (p) => (p && !path.isAbsolute(p) ? path.join(ROOT, p) : p);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PDF hashes that already have markdown, from the archives or a previous run. */
function alreadyConverted() {
  const have = new Set();
  for (const dir of ARCHIVES) {
    if (!fs.existsSync(dir)) continue;
    for (const submission of fs.readdirSync(dir)) {
      const base = path.join(dir, submission);
      if (!fs.statSync(base).isDirectory()) continue;
      for (const round of fs.readdirSync(base).filter((d) => /^round-\d+$/.test(d))) {
        const pdfDir = path.join(base, round, 'pdf');
        const mdDir = path.join(base, round, 'markdown');
        if (!fs.existsSync(pdfDir) || !fs.existsSync(mdDir)) continue;
        if (!fs.readdirSync(mdDir).some((f) => f.endsWith('.md'))) continue;
        for (const pdf of fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith('.pdf'))) {
          have.add(sha256(path.join(pdfDir, pdf)));
        }
      }
    }
  }
  if (fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.md'))) {
      have.add(path.basename(f, '.md'));
    }
  }
  return have;
}

async function main() {
  if (!fs.existsSync(INVENTORY)) {
    console.error('Run scripts/dev/inventory-corpus.js --json tmp/corpus/inventory.json first.');
    process.exit(1);
  }
  if (!markdownConfig.isConfigured()) {
    console.error('The PDF-to-markdown provider is not configured; nothing would convert.');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const limit = arg('--limit', Infinity);
  const staggerSeconds = arg('--stagger', 80);

  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf-8'));
  const all = [...inventory.usable, ...inventory.unusable].filter((d) => d.pdf);
  const have = alreadyConverted();

  const todo = all
    .filter((d) => !have.has(d.pdfSha))
    // KRT-bearing manuscripts first: those are the ones a corpus can use.
    .sort((a, b) => (b.krtInfo?.ok === true) - (a.krtInfo?.ok === true));

  const withKrt = todo.filter((d) => d.krtInfo?.ok).length;
  console.log(`provider          ${markdownConfig.provider}`);
  console.log(`distinct PDFs     ${all.length}`);
  console.log(`already converted ${all.length - todo.length}`);
  console.log(`to convert        ${todo.length}   (${withKrt} of them have a usable author KRT)`);
  console.log(`stagger           ${staggerSeconds}s between calls, sequential`);

  if (dryRun) {
    console.log('\n--dry-run: nothing will be converted. Order:');
    for (const d of todo.slice(0, Number.isFinite(limit) ? limit : todo.length)) {
      console.log('  ', (d.krtInfo?.ok ? 'KRT ' : '    '), d.manuscriptId.slice(0, 50));
    }
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  let done = 0;
  let failed = 0;

  const queue = todo.slice(0, Number.isFinite(limit) ? limit : todo.length);
  for (const [i, entry] of queue.entries()) {
    const label = `${i + 1}/${queue.length} ${entry.manuscriptId.slice(0, 44)}`;
    try {
      const markdown = await convertToMarkdown(fs.readFileSync(inRepo(entry.pdf)), path.basename(inRepo(entry.pdf)));
      const out = path.join(OUT_DIR, `${entry.pdfSha}.md`);
      fs.writeFileSync(out, markdown);
      done += 1;
      console.log(`  ok   ${label}  ${Math.round(markdown.length / 1024)}KB`);
    } catch (err) {
      failed += 1;
      // Keep going. One manuscript the converter cannot handle is a fact about
      // that manuscript — XC1-000312-009 has failed reproducibly for weeks — and
      // is not a reason to abandon the other forty.
      console.log(`  FAIL ${label}  ${String(err.message).slice(0, 90)}`);
    }
    if (i < queue.length - 1) await sleep(staggerSeconds * 1000);
  }

  const minutes = Math.round((Date.now() - started) / 60000);
  console.log(`\nconverted ${done}, failed ${failed}, in ~${minutes} min`);
  console.log(`markdown in ${path.relative(ROOT, OUT_DIR)}/<pdf-sha>.md`);
  console.log('Unpublished manuscripts — keep them under tmp/, never commit them.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
