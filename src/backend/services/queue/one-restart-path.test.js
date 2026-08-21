/**
 * Every step re-runs the same way.
 *
 * A step that re-runs by INSERTING a second `SubmissionJob` row is the shape of
 * the worst bug this pipeline has had: `getForSubmission` keeps only the newest
 * row per type, so the rival row HIDES the pipeline's own. The advancement that
 * should have followed lands on the wrong row, the real one sits in `waiting`
 * for ever, and the run reports itself complete. That is how a Generated KRT
 * shipped with 98 author rows and zero detections while datasets detection
 * alone had found 96 items.
 *
 * Four steps were converted to `requeueStep` as their individual failures were
 * observed, and a doc then generalised that into "there is exactly one way" —
 * which was untrue for the other eight. This test is what makes the claim real:
 * it fails if any service goes back to inserting a row.
 *
 * It reads the source rather than exercising each service, deliberately. The
 * property is structural — "no queue function creates its own row" — and a
 * behavioural test per service would pass while a ninth service added tomorrow
 * quietly reintroduced the bug.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..');

/** Every service file, recursively, excluding tests. */
function serviceFiles(dir = SERVICES_DIR, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serviceFiles(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

const rel = (f) => path.relative(SERVICES_DIR, f);

test('no service creates a SubmissionJob row except the orchestrator', () => {
  // The orchestrator is the one place allowed to: `runAllProcesses` seeds the
  // round, and `requeueStep` creates a row only when a step has none at all.
  const offenders = serviceFiles()
    .filter((f) => rel(f) !== path.join('queue', 'orchestrator.service.js'))
    .filter((f) => /SubmissionJob\.create\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);

  assert.deepEqual(offenders, [],
    'these insert their own job row instead of re-using the round\'s through requeueStep');
});

test('every queue* function goes through requeueStep', () => {
  const missing = [];
  for (const file of serviceFiles()) {
    if (rel(file) === path.join('queue', 'orchestrator.service.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(/async function (queue[A-Z]\w*)\s*\(/g)) {
      // The function body, up to the next top-level close.
      const start = match.index;
      const end = src.indexOf('\n}\n', start);
      const body = src.slice(start, end === -1 ? undefined : end);
      if (!body.includes('requeueStep')) missing.push(`${rel(file)}:${match[1]}`);
    }
  }

  assert.deepEqual(missing, [], 'these re-run a step without going through requeueStep');
});

/**
 * Every queue function, discovered rather than listed, so a new one is covered
 * the day it is written.
 * @returns {{module: string, fn: string}[]}
 */
function queueFunctions() {
  const out = [];
  for (const file of serviceFiles()) {
    if (rel(file) === path.join('queue', 'orchestrator.service.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(/async function (queue[A-Z]\w*)\s*\(/g)) {
      out.push({ module: file, fn: match[1], label: `${rel(file)}:${match[1]}` });
    }
  }
  return out;
}

/**
 * Run every queue function against a stubbed orchestrator and model, with the
 * step's PREVIOUS status set to `previous`.
 *
 * Behavioural, not textual: an earlier version of this test only checked that
 * the token `alreadyInFlight` appeared in the source, which a mutation setting
 * it to a constant `false` sailed straight through.
 */
async function callEachWith(t, previous) {
  const { SubmissionJob, Submission } = require('../../models');
  const orchestrator = require('./orchestrator.service');

  t.mock.method(SubmissionJob, 'getLatest', async () => (previous ? { id: 'row', status: previous } : null));
  // `queueDasSuggestions` reads the statement before it will queue anything —
  // without a statement it returns `no_statement` and never reaches the
  // re-queue, so the sweep would be testing nothing for that one.
  t.mock.method(Submission, 'findByPk', async () => ({ dataAvailabilityStatement: 'Data are available at Zenodo.' }));
  t.mock.method(orchestrator, 'cascadeRestart', async () => []);
  // requeueStep always hands back a `queued` row — the trap this guards.
  t.mock.method(orchestrator, 'requeueStep', async () => ({ id: 'row', status: 'queued', pgBossJobId: 'pg-1' }));

  const results = [];
  for (const { module, fn, label } of queueFunctions()) {
    const mod = require(module);
    if (typeof mod[fn] !== 'function') continue;
    let value;
    try {
      value = await mod[fn]('sub-1', 1, 'user-1');
    } catch (error) {
      results.push({ label, error: error.message });
      continue;
    }
    results.push({ label, alreadyInFlight: value?.alreadyInFlight });
  }
  return results;
}

test('a step already in flight is reported as such, by every queue function', async (t) => {
  // The bug this pins: the answer used to be derived from the status AFTER
  // requeueStep had set it to `queued`, so every re-run claimed to be "already
  // running" — including ones started that instant.
  const results = await callEachWith(t, 'processing');
  const wrong = results.filter((r) => r.alreadyInFlight !== true);

  assert.deepEqual(wrong, [], 'these did not notice the step was already running');
  assert.ok(results.length >= 10, `expected every queue function to be exercised, got ${results.length}`);
});

test('a step that was finished or failed is reported as a fresh run', async (t) => {
  for (const previous of ['complete', 'failed', 'waiting', null]) {
    const results = await callEachWith(t, previous);
    const wrong = results.filter((r) => r.alreadyInFlight !== false);
    assert.deepEqual(wrong, [], `previous status ${previous} must read as a fresh run`);
    t.mock.restoreAll();
  }
});

test('the rule covers every step in the pipeline, not just the ones with a queue function', () => {
  // Guards against the list quietly shrinking: if a queue function is deleted
  // rather than converted, the tests above pass vacuously.
  const found = serviceFiles()
    .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/async function (queue[A-Z]\w*)\s*\(/g)]
      .map((m) => m[1]));

  assert.ok(found.length >= 10,
    `expected a queue function per re-runnable step, found ${found.length}: ${found.join(', ')}`);
});

test('the DAS extraction endpoint re-runs the step rather than doing the work itself', async (t) => {
  // The last place a "re-run" bypassed the pipeline entirely. It called
  // `extractAndSaveDAS` inside the request: the extraction happened, but the
  // job row kept the PREVIOUS run's status, result, frozen inputs and prompt,
  // so the module page described a run that was no longer the latest — and
  // nothing downstream re-ran, so consolidation and the Availability check kept
  // answers built from a statement that had just been replaced.
  const pdfService = require('../pdf/pdf.service');
  const controller = require('../../controllers/pdf.controller');

  let queued = false;
  let ranDirectly = false;
  t.mock.method(pdfService, 'queueDASExtraction', async () => {
    queued = true;
    return { job: { id: 'row-1', status: 'queued' }, alreadyInFlight: false };
  });
  t.mock.method(pdfService, 'extractAndSaveDAS', async () => {
    ranDirectly = true;
    return { status: 'done', data: { meta: { das: 'x' } } };
  });

  const body = await new Promise((resolve) => {
    const res = { statusCode: 200, json: resolve, status(c) { this.statusCode = c; return this; } };
    controller.extractDAS(
      { submission: { id: 'sub-1', currentRound: 1 }, userId: 'user-1', params: {}, body: {} },
      res,
      resolve
    );
  });

  assert.equal(queued, true, 'it must go through the pipeline');
  assert.equal(ranDirectly, false, 'and must not do the extraction inside the request');
  assert.match(body.message, /queued/i);
});
