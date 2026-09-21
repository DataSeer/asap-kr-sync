/**
 * In-detector deduplication
 *
 * The last step of every detection module's three-step pipeline:
 *   detect<X>  →  buildKrtItems<X>  →  dedupeKrtItems
 *
 * Uses the same match rule mergeDetections uses cross-detector (same
 * resourceType, same newReuse, identifier-token intersection OR name match)
 * so in-detector and cross-detector dedup behave identically. Each output
 * item carries a `mergedFrom` array recording every pre-dedup contributor.
 *
 * Implementation strategy: rather than duplicate the match/absorb primitives
 * from merge-detections.service, we wrap a single-source mergeDetections call
 * and reshape the result back to the KrtEntry shape. Trade-off: one extra
 * adapter pass; benefit: one algorithm to maintain and test.
 *
 * Pure function — no I/O, no async.
 */

const { pickBestEvidence } = require('./evidence.service');
const { mergeDetections } = require('./merge-detections.service');
const { curateCandidates } = require('./curate-candidates.service');

/**
 * Curate, then dedupe an array of KrtEntry items.
 *
 * Curation first (curate-candidates.service.js): the corrections we are
 * certain of — a protocol-venue identifier is a Protocol, a platform name is
 * not a resource, a kit is not software — have to happen BEFORE any merging,
 * because `shouldMerge` refuses to merge rows that disagree on the resource
 * type. Retyping a protocol here is what lets it collapse into the Protocol
 * row the protocol detectors found for the same DOI instead of surviving as a
 * rival Software/code row.
 *
 * It lives in this function rather than in each detector on purpose: this is
 * the one call every detector already makes, so a detector added later cannot
 * skip curation without noticing.
 *
 * @param {object[]} items
 * @param {string} [sourceLabel='detector'] - used as the `source` field on
 *   each mergedFrom contributor record. Falls back to the originalItem's
 *   `origin` if set.
 * @param {object} [options]
 * @param {object[]} [options.curationLog] - sink: every curation action is
 *   pushed here, so a caller can report what it changed. Keeps this function
 *   pure (no logging I/O of its own).
 * @param {object} [options.curationPolicy] - which curation rules run, from
 *   the submission's pipeline (`config/pipelines.js` → `curation`). Omitted =
 *   every rule, which is what a caller without a submission should get.
 * @returns {object[]} KrtEntry[] with `mergedFrom` populated
 */

function dedupeKrtItems(items, sourceLabel = 'detector', { curationLog, curationPolicy } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const curated = curateCandidates(items, sourceLabel, curationPolicy);
  if (Array.isArray(curationLog)) curationLog.push(...curated.curationLog);
  if (curated.items.length === 0) return [];

  // mergeDetections walks the contributions flat and merges by shouldMerge.
  // Wrapping our items as a single contribution is exactly the in-detector
  // dedup we want.
  const merged = mergeDetections([{ source: sourceLabel, items: curated.items }]);

  // Adapt GeneratedResource → KrtEntry. mergeDetections strips a few fields
  // (origin, detectorMeta) and renames `source` → `sourceUrl`, so we restore
  // them from the highest-confidence original item.
  return merged.map(g => {
    const contributions = g.detectedBy || [];
    const best = contributions.reduce(
      (acc, d) => ((d?.confidence ?? 0) > (acc?.confidence ?? 0) ? d : acc),
      contributions[0] || { confidence: 0, originalItem: {} }
    );
    const bestItem = best.originalItem || {};
    return {
      resourceType: g.resourceType,
      resourceName: g.resourceName,
      identifier: g.identifier,
      source: g.sourceUrl,
      newReuse: g.newReuse,
      origin: bestItem.origin || sourceLabel,
      confidence: g.confidence,
      additionalInformation: g.additionalInformation,
      // Preserve detector-private metadata from the strongest contributor.
      // Other contributors' detectorMeta lives on their originalItem in
      // mergedFrom, so nothing is lost.
      ...(bestItem.detectorMeta ? { detectorMeta: bestItem.detectorMeta } : {}),
      // Manuscript evidence, picked across ALL contributors rather than taken
      // from the highest-confidence one: the strongest contributor is not
      // necessarily the best-grounded, and dropping this here silently broke
      // every downstream consumer (the modal's context line, the grounding
      // matcher, and the evidence attached to suggestions).
      ...(pickBestEvidence(contributions.map(c => c?.originalItem?.evidence))
        ? { evidence: pickBestEvidence(contributions.map(c => c?.originalItem?.evidence)) } : {}),
      mergedFrom: contributions.map(d => ({
        confidence: d.confidence,
        originalItem: d.originalItem
      }))
    };
  });
}

module.exports = { dedupeKrtItems };
