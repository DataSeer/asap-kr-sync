/**
 * The detector group each KRT resource type belongs to.
 *
 * These numbers index `getResourceTypeGroupOrder()` — the configured mapping
 * from RESOURCE TYPE to detector. They were previously re-declared as bare
 * literals in every service that loaded seeds (`const MATERIAL_GROUP = 3;` in
 * materials, again in protocols, again in the benchmark harness). Four copies
 * of a magic number that must agree, with nothing to make them.
 *
 * Naming them here does not change any behaviour; it just makes a mismatch a
 * broken import instead of a detector that silently seeds from the wrong rows.
 */
const GROUP = Object.freeze({
  dataset: 0,
  software: 1,
  protocol: 2,
  material: 3
});

module.exports = { GROUP };
