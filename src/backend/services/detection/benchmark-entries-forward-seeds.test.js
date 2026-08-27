/**
 * The pure/benchmark detection entry points must forward their seeds.
 *
 * `detectDatasets`, `detectMaterials` and `detectProtocols` are what an offline
 * harness calls to reproduce the pipeline without a database — batch-detection-
 * check.js and the seeded-vs-blind comparison both go through them. Each accepts
 * a prompt override so a caller can supply the strategy's prompt.
 *
 * All three used to accept the prompt and nothing else, while the
 * `callGeminiForX` beneath them already took `{prompt, seeds, seedTitle}`. So a
 * harness reproducing the SEEDED strategy got the seeded prompt with an empty
 * seed list: a prompt that says "enrich the author's list", and no list.
 *
 * That fails silently, and in the worst way for an experiment. Both arms of a
 * seeded-vs-blind comparison would run effectively blind, differing only in
 * prompt wording, and the result would look like a real measurement.
 *
 * Nothing here calls a model. The assembler is pure, so what the model WOULD
 * receive can be asserted directly; the wiring between the entry point and the
 * assembler is asserted structurally.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { assembleTextPrompt, seedBlock, SEED_TITLES } = require('./prompt-assembly');

const SEEDS = [{ name: 'Rabbit anti-TH', identifiers: ['AB_2201407'] }];

// ─────────────────────────────────────────────────────────────────────────────
// What a seed does once it arrives
// ─────────────────────────────────────────────────────────────────────────────

test('a seed reaches the model only if it is passed', () => {
  const withSeeds = assembleTextPrompt({
    prompt: 'PROMPT BODY', seeds: SEEDS,
    seedTitle: SEED_TITLES.materials, markdownText: 'manuscript'
  });
  const without = assembleTextPrompt({
    prompt: 'PROMPT BODY', seeds: [],
    seedTitle: SEED_TITLES.materials, markdownText: 'manuscript'
  });

  assert.match(withSeeds, /Rabbit anti-TH/);
  assert.ok(!/Rabbit anti-TH/.test(without));
  // The difference is the whole independent variable of the experiment.
  assert.notEqual(withSeeds, without);
});

test('an empty seed list adds no block at all', () => {
  // Not merely "no names" — an empty heading would still tell the model it was
  // given a list and found it empty, which is a different instruction.
  //
  // The argument order is (title, seeds). An earlier draft had it reversed and
  // passed anyway: `Array.isArray(aTitleString)` is false, so it returned '' for
  // the wrong reason and would have kept passing with the function broken.
  assert.equal(seedBlock(SEED_TITLES.materials, []), '');
  assert.equal(seedBlock(SEED_TITLES.materials, null), '');
  // And the positive case, so the assertion above cannot pass vacuously.
  assert.match(seedBlock(SEED_TITLES.materials, SEEDS), /Rabbit anti-TH/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring, read from source
// ─────────────────────────────────────────────────────────────────────────────

/** The body of a named async function, up to its closing brace at column 0. */
function bodyOf(source, fn) {
  const start = source.indexOf(`async function ${fn}(`);
  if (start === -1) return null;
  const end = source.indexOf('\n}', start);
  return source.slice(start, end === -1 ? undefined : end);
}

const CASES = [
  ['../datasets/datasets.service.js', 'detectDatasets', 'callGeminiForConsolidation'],
  ['../materials/materials.service.js', 'detectMaterials', 'callGeminiForMaterials'],
  ['../protocols/protocols.service.js', 'detectProtocols', 'callGeminiForProtocols']
];

test('every benchmark entry point accepts seeds', () => {
  for (const [file, fn] of CASES) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const signature = source.match(new RegExp(`async function ${fn}\\([^)]*\\)`));
    assert.ok(signature, `${fn} not found — did it move or get renamed?`);
    assert.match(signature[0], /seeds/,
      `${fn} must accept seeds, or an offline seeded run is silently blind`);
  }
});

test('and passes them on, rather than accepting and dropping them', () => {
  // Accepting `seeds` and never using it is exactly as broken as not accepting
  // it, and looks correct from the signature alone.
  for (const [file, fn, callee] of CASES) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const body = bodyOf(source, fn);
    assert.ok(body, `${fn} body not found`);

    const call = body.slice(body.indexOf(callee));
    assert.ok(call.length, `${fn} does not call ${callee}`);
    assert.match(call, /seeds/,
      `${fn} accepts seeds but never hands them to ${callee}`);
  }
});

test('the scan is looking at real code, not passing on an empty read', () => {
  // A guard that finds nothing passes forever. These three files exist and each
  // holds the function this test claims to police.
  for (const [file, fn] of CASES) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(source.length > 1000, `${file} is suspiciously small`);
    assert.ok(bodyOf(source, fn), `${fn} missing from ${file}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// And the harness that calls them
// ─────────────────────────────────────────────────────────────────────────────

test('the strategy harness passes the seeds it computes', () => {
  // The entry points were fixed to ACCEPT seeds and the caller was not updated
  // to SEND them, so `run-strategy-arms.js` computed a seed list per detector,
  // logged its length in the dry-run, and then called each detector with
  // `{ prompt }` alone. The seeded arm ran a prompt that says "re-ground and
  // lightly enrich the rows you were given" with no rows — a malformed
  // instruction, not the seeded strategy — and every number it produced had to
  // be discarded.
  //
  // Exactly the mistake this file already guards one layer down, which is why it
  // is worth guarding here too: fixing a signature does not fix its callers.
  const harness = path.join(__dirname, '../../../../scripts/dev/run-strategy-arms.js');
  if (!fs.existsSync(harness)) return;   // the harness is a dev script; absence is fine

  const source = fs.readFileSync(harness, 'utf8');
  const body = source.slice(source.indexOf('async function detect('));
  const detectFn = body.slice(0, body.indexOf('\n}'));

  for (const call of ['detectDatasets', 'detectMaterials', 'detectProtocols']) {
    const at = detectFn.indexOf(call);
    assert.ok(at !== -1, `${call} not called by the harness`);
    // The options object passed to this call, up to its closing brace.
    const opts = detectFn.slice(at, detectFn.indexOf('}', at));
    assert.match(opts, /seeds/,
      `${call} is called without seeds — the seeded arm would run on an empty list`);
  }
});
