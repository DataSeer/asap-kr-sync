/**
 * A seeded run that drops most of its seeds must not report success.
 *
 * The three seeded prompts each open by promising one output row per author
 * seed — "never drop one" (materials), "never drop, split, or merge-away an
 * author protocol", "emit one canonical record for every entry in
 * `author_provided_datasets`". Nothing checked whether they did.
 *
 * The failure that exposed it: seeded materials given 42 author rows returned an
 * empty list in four seconds, the job completed, `counts.total` read 0, and the
 * module page said "found nothing" — which is exactly what it says for a
 * manuscript that contains no materials. Two different situations, one message,
 * and no way for a curator to tell them apart.
 *
 * The thresholds here are set from measurement, not taste, so the tests use the
 * real numbers. Every observed good run and every observed bad one is a case
 * below.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  seedCoverageShortfall, batchSeeds, MIN_SEED_COVERAGE, MAX_SEEDS_PER_CALL
} = require('./seed-coverage');

const check = (seedCount, returnedCount, detector = 'materials') =>
  seedCoverageShortfall({ seedCount, returnedCount, detector });

// ─────────────────────────────────────────────────────────────────────────────
// The runs that actually happened
// ─────────────────────────────────────────────────────────────────────────────

test('the three runs that honoured the contract pass', () => {
  // RE2 53/53, MD1 85/90, JJ1 48/38 — the last returned MORE than its seeds,
  // which is the strategy working as designed: every seed re-grounded, plus ten
  // genuine discoveries.
  assert.equal(check(53, 53), null);
  assert.equal(check(90, 85), null);
  assert.equal(check(38, 48), null);
});

test('the two that broke it are flagged', () => {
  // WH1 29/190 and CS1 0/42.
  const wh1 = check(190, 29);
  const cs1 = check(42, 0);

  assert.ok(wh1, '29 rows from 190 seeds must not pass as a clean result');
  assert.ok(cs1, 'an empty list from 42 seeds must not pass as "found nothing"');
  assert.equal(wh1.engine, 'materials_seeded');
  assert.match(wh1.error, /190/);
  assert.match(wh1.error, /29/);
});

test('the message says what happened and why it is being reported', () => {
  // It reaches a curator through the issue panel, so it has to explain itself
  // to someone who did not read this file.
  const { error } = check(42, 0);

  assert.match(error, /told to emit one for each/);
  assert.match(error, /reads exactly like a manuscript with nothing in it/);
});

// ─────────────────────────────────────────────────────────────────────────────
// The boundary
// ─────────────────────────────────────────────────────────────────────────────

test('an unseeded run has no contract to break', () => {
  // The blind strategies promise nothing about counts, and neither does a
  // seeded run whose author table happened to be empty. Flagging those would
  // fire on every blind run in the corpus.
  assert.equal(check(0, 0), null);
  assert.equal(check(0, 40), null);
  assert.equal(check(undefined, 0), null);
});

test('the threshold is lenient, because merging two author rows is legitimate', () => {
  const seeds = 100;
  assert.equal(check(seeds, seeds * MIN_SEED_COVERAGE), null, 'exactly at the line passes');
  assert.ok(check(seeds, (seeds * MIN_SEED_COVERAGE) - 1), 'below it does not');
});

test('nothing observed sits near the line', () => {
  // The good runs were at 94% and above, the bad at 15% and 0%. A threshold
  // anywhere in that gap separates them, which is why 0.5 costs no true
  // positives — worth pinning, because a later tuning that narrows the margin
  // should have to justify itself against this.
  const worstGood = Math.min(53 / 53, 85 / 90, 48 / 38);
  const bestBad = Math.max(29 / 190, 0 / 42);

  assert.ok(worstGood > MIN_SEED_COVERAGE + 0.3, 'good runs sit well above');
  assert.ok(bestBad < MIN_SEED_COVERAGE - 0.3, 'bad runs sit well below');
});

// ─────────────────────────────────────────────────────────────────────────────
// Batching, the preventive half
// ─────────────────────────────────────────────────────────────────────────────

test('a seed list that fits is left alone', () => {
  // Splitting a working request costs a second model call and a merge. Every
  // list observed to work is below the ceiling and must stay in one call.
  for (const n of [38, 42, 53, 90]) {
    assert.equal(batchSeeds(new Array(n).fill({})).length, 1, `${n} seeds`);
  }
});

test('a list far past the ceiling is split, and keeps every seed', () => {
  const seeds = Array.from({ length: 190 }, (_, i) => ({ name: `s${i}` }));
  const batches = batchSeeds(seeds);

  assert.ok(batches.length > 1, '190 seeds is the size that failed; it must split');
  assert.equal(batches.flat().length, 190, 'no seed may be dropped to make it fit');
  assert.deepEqual(batches.flat().map((s) => s.name), seeds.map((s) => s.name),
    'and the order must survive, so a re-run is comparable');
  for (const b of batches) assert.ok(b.length <= MAX_SEEDS_PER_CALL);
});

test('batching alone would not have caught the worse failure', () => {
  // CS1 failed at 42 seeds — comfortably inside a single batch. Pinned so that
  // nobody later reads the batching as the fix and removes the guard.
  assert.equal(batchSeeds(new Array(42).fill({})).length, 1);
  assert.ok(check(42, 0), 'the guard is what catches this one');
});

test('degenerate inputs do not throw', () => {
  assert.deepEqual(batchSeeds([]), [[]]);
  assert.deepEqual(batchSeeds(null), [[]]);
  assert.deepEqual(batchSeeds(undefined), [[]]);
});
