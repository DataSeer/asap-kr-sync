/**
 * The seam between the Python extraction pass and the token tally.
 *
 * langextract reports nothing about what it spends, so the pass is counted by
 * wrapping the Google SDK's `Models.generate_content` inside the Python script
 * and printing the total alongside the extractions. Two things hold that
 * together, and both are invisible from Node:
 *
 *   1. the script prints an OBJECT (`extractions` / `usage` / `model`), not the
 *      bare array it printed before;
 *   2. it hooks `google.genai.models`, not langextract's internals.
 *
 * If either moves — a langextract upgrade, an SDK rename, someone restoring the
 * old bare-array output — the failure mode is a figure that is quietly short by
 * a whole extraction pass, which nobody would notice. These tests are the
 * canary: they read the script and fail loudly rather than let that happen.
 *
 * Run with: node --test src/backend/services/datasets/langextract-usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '../../python/datasets/extract-signals.py'),
  'utf8'
);

test('the script still hooks the SDK, not langextract internals', () => {
  // The whole reason this hook point was chosen: it is a documented public API
  // that langextract has to call, so it outlives langextract's own structure.
  assert.match(SCRIPT, /from google\.genai\.models import Models/,
    'the usage hook is gone or has moved — the extraction pass is no longer counted');
  assert.match(SCRIPT, /Models\.generate_content = _counting_generate/,
    'the wrapper is no longer installed');
  assert.match(SCRIPT, /_M\.generate_content = _original_generate/,
    'the SDK is no longer restored after the run');
});

test('the script still prints the object the client parses', () => {
  assert.match(SCRIPT, /"extractions": extractions/,
    'output contract changed — the Node client parses an object with this key');
  assert.match(SCRIPT, /"usage": usage/,
    'usage is no longer reported, so the pass would be silently uncounted');
});

test('usage is null rather than zero when nothing could be counted', () => {
  // `usage: null` is how the Node client learns to NAME the gap. A zeroed
  // object would read as "this pass was free", which is the one wrong answer.
  assert.match(SCRIPT, /usage_ok and usage_totals\["calls"\] > 0/,
    'the null-vs-zero distinction is gone');
});

test('counting never breaks the extraction', () => {
  // An accounting figure must not be able to fail a document. Both the hook
  // installation and the per-call read are wrapped.
  const guarded = SCRIPT.match(/except Exception/g) || [];
  assert.ok(guarded.length >= 3,
    'the usage capture is no longer fully guarded — it could now fail a run');
  assert.match(SCRIPT, /Token usage capture unavailable/,
    'a failed hook no longer says so on stderr');
});

test('the tally is only ever told about a model it was given', () => {
  // The script reports the model it ran with, so a pass that used something
  // other than the configured model is priced as what it actually called.
  assert.match(SCRIPT, /"model": args\.model/,
    'the model is no longer reported alongside usage');
});
