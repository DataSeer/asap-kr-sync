#!/usr/bin/env node
/**
 * Compare datasets-detection results across two sets of prompt/example
 * resources (e.g. *_v1 vs *_v2) over all demo PDFs.
 *
 * Pipeline per PDF: markdown convert (cached, run ONCE per PDF and reused for
 * every version so the comparison is fair) -> datasets detection with each
 * version's three override files -> canonical KRT items (build + dedupe).
 *
 * Resource files expected in <resourcesDir>, one set per version:
 *   datasets-consolidation_<ver>.txt        -> consolidation prompt
 *   datasets-signals-extraction_<ver>.txt   -> langextract signal prompt
 *   datasets-signals-examples_<ver>.json    -> langextract few-shot examples
 *
 * Usage:
 *   node scripts/compare-datasets-prompts.js [pdfDir] [resourcesDir] [outDir] [limit]
 *
 * Defaults:
 *   pdfDir       src/frontend/public/demo-files
 *   resourcesDir tmp/datasets-detection
 *   outDir       tmp/datasets-detection/results
 *   limit        0 (all PDFs; set a small number to smoke-test first)
 *
 * Outputs under <outDir>:
 *   markdown/<pdf>.md            cached markdown (shared across versions)
 *   <ver>/<pdf>.json             { signalCount, resourceCount, krtCount, krt }
 *   summary.csv                  pdf, <ver> krt counts side by side
 *
 * NOTE: heavy — 50 PDFs x 2 versions hits Gemini + langextract many times.
 * Requires the same env as the app (GEMINI key, Python langextract). Start
 * with a small `limit` to validate before the full run.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { convertToMarkdown } = require('../src/backend/services/pdf/pdf-markdown-client.service');
const datasetsService = require('../src/backend/services/datasets/datasets.service');
const { dedupeKrtItems } = require('../src/backend/services/pdf-analysis/dedupe-krt-items.service');

const VERSIONS = ['v1', 'v2'];

const pdfDir = path.resolve(process.argv[2] || 'src/frontend/public/demo-files');
const resourcesDir = path.resolve(process.argv[3] || 'tmp/datasets-detection');
const outDir = path.resolve(process.argv[4] || 'tmp/datasets-detection/results');
const limit = parseInt(process.argv[5], 10) || 0;

function loadResources(version) {
  const read = (file) => fs.readFileSync(path.join(resourcesDir, file), 'utf-8');
  return {
    prompt: read(`datasets-consolidation_${version}.txt`),
    signalsPrompt: read(`datasets-signals-extraction_${version}.txt`),
    signalsExamples: read(`datasets-signals-examples_${version}.json`)
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Convert once per PDF and cache to disk; reuse for every version.
async function getMarkdown(pdfPath, name, mdDir) {
  const mdPath = path.join(mdDir, `${name}.md`);
  if (fs.existsSync(mdPath) && fs.statSync(mdPath).size > 0) {
    return fs.readFileSync(mdPath, 'utf-8');
  }
  const pdfBuffer = fs.readFileSync(pdfPath);
  const markdown = (await convertToMarkdown(pdfBuffer, `${name}.pdf`)) || '';
  fs.writeFileSync(mdPath, markdown, 'utf-8');
  return markdown;
}

async function main() {
  // Validate resource sets up front so we fail fast, not mid-run.
  const resourcesByVersion = {};
  for (const version of VERSIONS) {
    resourcesByVersion[version] = loadResources(version);
    console.error(`Loaded ${version} resources from ${resourcesDir}`);
  }

  const mdDir = path.join(outDir, 'markdown');
  ensureDir(mdDir);
  VERSIONS.forEach((v) => ensureDir(path.join(outDir, v)));

  let pdfs = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (limit > 0) pdfs = pdfs.slice(0, limit);
  console.error(`Processing ${pdfs.length} PDFs from ${pdfDir}\n`);

  const summary = [];

  for (const pdfFile of pdfs) {
    const name = path.basename(pdfFile, '.pdf');
    const row = { pdf: name };
    try {
      const markdown = await getMarkdown(path.join(pdfDir, pdfFile), name, mdDir);

      for (const version of VERSIONS) {
        try {
          const { resources, signalCount } = await datasetsService.detectDatasets(markdown, resourcesByVersion[version]);
          const krt = dedupeKrtItems(datasetsService.buildKrtItemsDatasets(resources), 'datasets-gemini');
          fs.writeFileSync(
            path.join(outDir, version, `${name}.json`),
            JSON.stringify({ signalCount, resourceCount: resources.length, krtCount: krt.length, krt }, null, 2)
          );
          row[version] = krt.length;
          console.error(`  ${name} [${version}] -> ${krt.length} KRT items (${signalCount} signals)`);
        } catch (verErr) {
          row[version] = `ERROR: ${verErr.message}`;
          console.error(`  ${name} [${version}] FAILED: ${verErr.message}`);
        }
      }
    } catch (mdErr) {
      VERSIONS.forEach((v) => { row[v] = `MD_ERROR: ${mdErr.message}`; });
      console.error(`  ${name} markdown convert FAILED: ${mdErr.message}`);
    }
    summary.push(row);
  }

  // Write a side-by-side summary CSV.
  const header = ['pdf', ...VERSIONS].join(',');
  const lines = summary.map((r) => [r.pdf, ...VERSIONS.map((v) => r[v])].join(','));
  const csvPath = path.join(outDir, 'summary.csv');
  fs.writeFileSync(csvPath, `${header}\n${lines.join('\n')}\n`);

  console.error(`\nDone. Per-PDF results in ${outDir}/<version>/, summary: ${csvPath}`);
}

main().catch((err) => {
  console.error('Comparison run failed:', err.message);
  process.exit(1);
});
