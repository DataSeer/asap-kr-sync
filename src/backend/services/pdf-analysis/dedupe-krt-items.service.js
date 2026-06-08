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

const { mergeDetections } = require('./merge-detections.service');

/**
 * Dedupe an array of KrtEntry items.
 * @param {object[]} items
 * @param {string} [sourceLabel='detector'] - used as the `source` field on
 *   each mergedFrom contributor record. Falls back to the originalItem's
 *   `origin` if set.
 * @returns {object[]} KrtEntry[] with `mergedFrom` populated
 */
function dedupeKrtItems(items, sourceLabel = 'detector') {
  if (!Array.isArray(items) || items.length === 0) return [];

  // mergeDetections walks the contributions flat and merges by shouldMerge.
  // Wrapping our items as a single contribution is exactly the in-detector
  // dedup we want.
  const merged = mergeDetections([{ source: sourceLabel, items }]);

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
      mergedFrom: contributions.map(d => ({
        confidence: d.confidence,
        originalItem: d.originalItem
      }))
    };
  });
}

module.exports = { dedupeKrtItems };
