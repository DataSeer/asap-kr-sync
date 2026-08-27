/**
 * Mark detected items that correspond to a row in the author's KRT.
 *
 * Only meaningful under a seeded pipeline, where the prompt was handed those
 * rows and the model is instructed to emit every one of them. Without the mark,
 * a curator reading a detection table cannot tell a resource the model FOUND in
 * the manuscript from one it was given and copied back — and those are very
 * different claims about the paper.
 *
 * The mark says only "this corresponds to an author row". Whether the model
 * actually located it is already recorded, and more reliably, by the evidence
 * verdict attached to the same item:
 *
 *   verified     the model's quote is in the manuscript — a real find
 *   embellished  the quote is not, but the resource is
 *   (none)       nothing to check it against — copied back, not found
 *
 * Returns the items unchanged when there are no seeds, so a blind pipeline
 * carries no tag at all rather than a tag that is always false.
 */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @param {object[]} items - detected KRT items
 * @param {object[]} seeds - author seeds from buildAuthorSeeds ({name, ...})
 * @returns {object[]} the same items, tagged where they match a seed
 */
function tagAuthorRows(items, seeds) {
  if (!Array.isArray(items) || !Array.isArray(seeds) || seeds.length === 0) return items || [];

  const seedNames = new Set(seeds.map((s) => norm(s.name)).filter(Boolean));
  return items.map((item) => {
    if (!seedNames.has(norm(item?.resourceName))) return item;
    return {
      ...item,
      detectorMeta: { ...(item.detectorMeta || {}), fromAuthorKrt: true }
    };
  });
}

module.exports = { tagAuthorRows, norm };
