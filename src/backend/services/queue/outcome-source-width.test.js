/**
 * Every `outcome.source` a worker can emit has to fit its column.
 *
 * `step_executions.outcome_source` is STRING(16). A longer value does not fail
 * where it is written: the insert throws inside the run-history close, which is
 * deliberately caught and logged as "the run itself is unaffected". That is
 * true of the pipeline — the step completes and the page shows its results —
 * but the history row is left at `processing` with no outcome, for ever.
 *
 * Observed exactly that: `internal+external` is seventeen characters, and every
 * KRT Grounding execution on every submission was stuck open. Nothing failed,
 * five manuscripts finished 12/12, and the only trace was a line in the log.
 *
 * So the widths are checked here, against the sources the workers actually
 * write rather than a list somebody remembers to update.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { StepExecution } = require('../../models');

/**
 * The two files that produce an outcome source literal.
 *
 * Scanned by name rather than by walking the tree, because `source:` is also a
 * field on DETECTION rows — where the value is a module name or a protocol
 * venue and goes to a different column entirely. A blanket scan flags
 * `identifier_detection` and `Cold Spring Harbor Protocols` and says nothing
 * about the one value that matters.
 */
const SOURCE_PRODUCERS = [
  // `done('external' | 'demo', ...)` — the helper every module returns through.
  path.join(__dirname, '..', 'demo-fallback.service.js'),
  // The one worker that builds a snapshot with a literal source of its own.
  path.join(__dirname, 'workers.js')
];

/** Outcome-source literals, from the two shapes that produce them. */
function emittedSources() {
  const found = new Set();
  for (const file of SOURCE_PRODUCERS) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bdone\(\s*'([^']*)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/buildServiceSnapshot\([\s\S]{0,400}?\bsource:[^,}]*?'([^']*)'/g)) {
      found.add(m[1]);
    }
    // The ternary form: `source: cond ? 'a' : 'b'` inside a snapshot call.
    for (const m of src.matchAll(/\bsource:[^,}\n]*\?\s*'([^']*)'\s*:\s*'([^']*)'/g)) {
      found.add(m[1]); found.add(m[2]);
    }
  }
  return [...found];
}

test('the column is still the width this test assumes', () => {
  // If someone widens it, the check below should relax rather than silently
  // keep enforcing a limit that no longer exists.
  const type = StepExecution.rawAttributes.outcomeSource.type;

  assert.equal(type.options.length, 16, 'outcome_source width changed — update this test');
});

test('no worker emits an outcome source too long for the column', () => {
  const limit = StepExecution.rawAttributes.outcomeSource.type.options.length;
  const sources = emittedSources();

  // Sanity: the scan has to actually find the vocabulary, or it passes by
  // finding nothing — which is how a guard quietly stops guarding.
  assert.ok(sources.includes('external'), `expected the scan to find 'external', got ${JSON.stringify(sources)}`);
  assert.ok(sources.includes('demo'), 'expected the scan to find the demo source');
  assert.ok(sources.includes('both'), 'expected the scan to find the mixed source');

  const tooLong = sources.filter((v) => v.length > limit);

  assert.deepEqual(
    tooLong, [],
    `these exceed step_executions.outcome_source (${limit} chars). The insert `
    + 'throws inside the run-history close, which is caught — so the step still '
    + 'completes and its history row stays open at `processing`.'
  );
});
