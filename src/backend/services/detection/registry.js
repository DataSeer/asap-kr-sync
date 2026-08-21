/**
 * Every detection strategy the app knows about, indexed by id.
 *
 * A strategy supplies the model input for one detector under one pipeline. The
 * detector supplies everything else — the LM call, the generation config, the
 * parsing, the salvage, the evidence attachment, the item building — exactly
 * once, for every strategy.
 *
 * That split is deliberate. Three separate silent bugs on this codebase were
 * all "an LM call written without a generation config", each needing its own
 * fix in its own copy. Strategies exist so the two pipelines can differ in what
 * they ask WITHOUT giving that plumbing a second home.
 */

const STRATEGIES = [
  require('../materials/strategies/seeded'),
  require('../materials/strategies/blind'),
  require('../protocols/strategies/seeded'),
  require('../protocols/strategies/blind'),
  require('../datasets/strategies/seeded'),
  require('../datasets/strategies/blind')
];

const BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

/**
 * @param {string} id
 * @returns {object} the strategy
 * @throws if unknown — a typo in a pipeline must fail loudly at resolution,
 *   never fall back to a default that quietly detects differently.
 */
function getStrategy(id) {
  const found = BY_ID.get(id);
  if (!found) {
    throw new Error(`Unknown detection strategy "${id}". Known: ${[...BY_ID.keys()].sort().join(', ')}`);
  }
  return found;
}

/** Every strategy, for enumeration in tests. */
function allStrategies() { return [...STRATEGIES]; }

module.exports = { getStrategy, allStrategies };
