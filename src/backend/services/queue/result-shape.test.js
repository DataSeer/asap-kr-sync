/**
 * One result shape, across every module.
 *
 * A job's stored result is read by code that walks ALL modules without knowing
 * which one it has — the Technical detail panel, the pipeline cards, the job
 * API. So where a module puts its numbers is a contract, not a detail:
 *
 *   result.data.<module-specific payload>
 *   result.data.meta   ← what the run recorded about itself
 *   result.files       ← artefacts, `inputs` among them
 *
 * The DAS check stored its meta beside `data` instead of inside it. Nothing
 * threw; its Statistics and Module-inputs columns simply rendered blank while
 * every other module's were fine — the failure mode of a shape drift is an
 * empty box, not an error, which is why it survived review and is pinned here.
 *
 * These assert on the SERVICES' persistence code rather than on a live job,
 * because the contract is what the code writes.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..');

/** Every service file that persists a job result itself. */
function servicesPersistingResults() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
      const src = fs.readFileSync(full, 'utf-8');
      if (src.includes('job.result = ')) out.push([path.relative(SERVICES_DIR, full), src]);
    }
  };
  walk(SERVICES_DIR);
  return out;
}

test('a module that writes its own result nests meta inside data', () => {
  const offenders = [];
  for (const [file, src] of servicesPersistingResults()) {
    // `meta: result.meta` at the TOP level of the assignment is the drift:
    // it must appear inside the `data: { ... }` object instead.
    for (const line of src.split('\n')) {
      if (!line.includes('job.result = ')) continue;
      const topLevelMeta = /job\.result\s*=\s*\{[^}]*\bmeta:/.test(line)
        && !/data:\s*\{[^}]*meta:/.test(line);
      if (topLevelMeta) offenders.push(`${file}: ${line.trim()}`);
    }
  }

  assert.deepEqual(offenders, [],
    'meta belongs at result.data.meta — every cross-module reader looks there');
});

test('a result assignment only ever writes data, status, files — never a bare meta', () => {
  // Deliberately about the SHAPE, not the spelling: a module whose helper
  // already nests meta inside `data` writes `data: helperResult.data`, which is
  // just as correct as spreading it. What must not appear is a `meta` key
  // beside `data`, because no cross-module reader looks there.
  const writers = servicesPersistingResults()
    .flatMap(([file, src]) => src.split('\n')
      .filter((l) => l.includes('job.result = '))
      .map((l) => [file, l.trim()]));

  assert.ok(writers.length >= 2, 'expected at least the DAS and datasets services');
  for (const [file, line] of writers) {
    const keys = [...line.matchAll(/([a-zA-Z]+):/g)].map((m) => m[1]);
    const topLevel = keys.filter((k) => !['id', 'items', 'suggestions', 'signals'].includes(k));
    assert.ok(!topLevel.includes('meta') || /data:\s*\{[^}]*meta:/.test(line),
      `${file} writes meta outside data: ${line}`);
  }
});

test('every module freezes its inputs', () => {
  // The note in the UI says so, and a reader auditing a run relies on it. A
  // module that quietly stops calling saveRunInputs would make that a lie.
  // One entry per module that runs work worth auditing. Listed rather than
  // discovered, so deleting a call fails here instead of shrinking the list to
  // match itself.
  const EXPECTED = [
    'pdf/pdf.service.js',                                    // DAS extraction
    'pdf/markdown-convert.service.js',                       // conversion
    'orcid/orcid.service.js',                                // authors
    'datasets/datasets.service.js',
    'materials/materials.service.js',
    'protocols/protocols.service.js',
    'software/software.service.js',
    'identifier-detection/identifier-detection.service.js',
    'krt-grounding/krt-grounding.service.js',
    'pdf-analysis/pdf-analysis.service.js',                  // the Generated KRT
    'suggestion/kr-comparison.service.js',
    'das-suggestions/das-suggestions.service.js'
  ];

  const missing = EXPECTED.filter((rel) => {
    const full = path.join(SERVICES_DIR, rel);
    if (!fs.existsSync(full)) return true;
    return !fs.readFileSync(full, 'utf-8').includes('saveRunInputs');
  });

  assert.deepEqual(missing, [], 'these modules no longer record what they were given');
});
