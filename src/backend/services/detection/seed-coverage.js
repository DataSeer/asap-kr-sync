/**
 * Did a seeded run return the rows it was told never to drop?
 *
 * All three seeded prompts open with the same instruction — materials: "Emit one
 * output row for every author-provided material. Never drop one."; protocols:
 * "Never drop, split, or merge-away an author protocol."; datasets: "Emit one
 * canonical record for every entry in `author_provided_datasets`." So a seeded
 * run that comes back with far fewer rows than it was given seeds has broken a
 * contract the prompt states outright, and that is checkable.
 *
 * Nothing checked it. `seedCount` was logged and recorded in meta and never
 * compared against the output, so the failure was silent in the worst way: the
 * job completed, `counts.total` read 0, and the module page said "found
 * nothing" — indistinguishable from a manuscript that genuinely contains no
 * materials. A curator had no way to tell the two apart.
 *
 * Measured across five manuscripts, seeded materials:
 *
 *     RE2   53 rows from  53 seeds     obeys
 *     MD1   85 rows from  90 seeds     obeys
 *     JJ1   48 rows from  38 seeds     obeys, and found ten more besides
 *     WH1   29 rows from 190 seeds     broken
 *     CS1    0 rows from  42 seeds     broken — returned [] in four seconds
 *
 * Bimodal rather than degrading with size, which is why a prompt-size limit
 * alone would not have caught CS1 at 42 seeds. This does not stop the model
 * returning an empty list; it makes the failure visible and retryable instead of
 * reporting it as a clean zero.
 *
 * Deliberately NOT a hard failure. A run that returned most of its seeds plus
 * real discoveries is worth keeping — degrading it to `partial` surfaces the
 * shortfall while leaving the results in place for a curator to use.
 */

'use strict';

/**
 * Below this share of its seeds, a seeded run is treated as having under-
 * delivered.
 *
 * 0.5 is deliberately lenient. Legitimate reasons to return fewer rows than
 * seeds exist — the model may merge two author rows describing one reagent —
 * and the observed good runs all landed at 94% or above (53/53, 85/90, 48/38).
 * The observed bad ones were 15% and 0%. Nothing real sits near the line, so a
 * generous threshold costs no true positives and avoids crying wolf over a
 * couple of merged rows.
 */
const MIN_SEED_COVERAGE = 0.5;

/**
 * @param {object} args
 * @param {number} args.seedCount - seeds this run was given
 * @param {number} args.returnedCount - rows it produced
 * @param {string} args.detector - 'materials' | 'protocols' | 'datasets'
 * @returns {{engine: string, error: string}|null} a `degraded` marker for
 *   `meta.degraded`, or null when coverage is acceptable. The shape matches what
 *   `demo-fallback.done()` already reads, so the outcome becomes `partial` with
 *   a `failReason` through the path every other degradation uses.
 */
function seedCoverageShortfall({ seedCount, returnedCount, detector }) {
  // An unseeded run has no contract to break — the blind strategies promise
  // nothing about counts, and neither does a seeded run with an empty table.
  if (!seedCount || seedCount <= 0) return null;
  if (returnedCount >= seedCount * MIN_SEED_COVERAGE) return null;

  const pct = Math.round((returnedCount / seedCount) * 100);
  return {
    engine: `${detector}_seeded`,
    error: `The prompt was given ${seedCount} author rows and told to emit one for each, `
      + `but returned ${returnedCount} (${pct}%). The result is kept, and flagged, `
      + 'because a silent short list reads exactly like a manuscript with nothing in it.'
  };
}

/**
 * Seeds per request.
 *
 * Set ABOVE every seed list observed to work, not at some tuned optimum. The
 * largest good run was 90 seeds (85 rows returned); the smallest bad one was
 * 190. 120 sits between them, so no currently-working manuscript changes
 * behaviour and only lists in the range that actually failed are split.
 *
 * That restraint is the point. Splitting a request that works costs a second
 * model call and introduces a merge, and there is no measurement telling us
 * where the real ceiling lies — only that 90 was fine and 190 was not. Lower it
 * when there is evidence, not by feel.
 */
const MAX_SEEDS_PER_CALL = 120;

/**
 * Split a seed list so no single request carries too many.
 *
 * The preventive half. WH1 returned 29 rows for 190 seeds; whatever the model
 * does with a list that long, it is not what the prompt asked. Splitting keeps
 * every seed — none is dropped to fit — at the cost of one request per batch,
 * which is only paid by the tables large enough to have caused the problem.
 *
 * It is NOT a complete fix and must not be mistaken for one: CS1 failed at 42
 * seeds, comfortably inside one batch. That is what the guard above is for.
 *
 * @param {object[]} seeds
 * @param {number} [size]
 * @returns {object[][]} one batch when the list is small enough, several when not
 */
function batchSeeds(seeds, size = MAX_SEEDS_PER_CALL) {
  const list = Array.isArray(seeds) ? seeds : [];
  if (list.length <= size) return [list];

  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

module.exports = { seedCoverageShortfall, batchSeeds, MIN_SEED_COVERAGE, MAX_SEEDS_PER_CALL };
