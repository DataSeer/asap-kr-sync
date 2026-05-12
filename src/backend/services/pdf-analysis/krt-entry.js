/**
 * Canonical KrtEntry shape
 *
 * Every detection module's pipeline ends with an array of KrtEntry items.
 * PDF Analysis reads these via `SubmissionJob.result.data.items` and runs them
 * through `mergeDetections` for cross-source dedup.
 *
 * This file is the single source of truth for what an "item" looks like once
 * it has left a detector. JS has no static types, so the shape lives in JSDoc
 * + a couple of small helpers used by tests and the snapshot harness.
 *
 * The four pipeline stages (per detector):
 *   1. detect<X>(input)            → raw detector output
 *   2. buildKrtItems<X>(raw)       → KrtEntry[] (canonical shape, NOT deduped)
 *   3. enrich<X>(items, source)    → KrtEntry[] (blanks filled from curated list)
 *   4. dedupeKrtItems(items)       → KrtEntry[] (one entry per logical resource)
 */

/**
 * @typedef {object} KrtEntry
 * @property {string} resourceType                  - 'Code/Software' | 'Dataset' | 'Protocol' | 'Lab Material' | ...
 * @property {string} resourceName                  - canonical display name
 * @property {string} identifier                    - ';'-joined when multiple
 * @property {string} source                        - URL or curator source string
 * @property {'new'|'reuse'|''} newReuse
 * @property {string} origin                        - detector label ('identifier-scan', 'softcite+list', ...)
 * @property {number} confidence                    - 0..1
 * @property {string} additionalInformation         - snippet / context / "Type: …"
 * @property {KrtMergeContribution[]} [mergedFrom]  - present after dedupeKrtItems
 * @property {KrtDetectorMeta} [detectorMeta]       - detector-private metadata (UI surfacing only)
 */

/**
 * @typedef {object} KrtMergeContribution
 * @property {number} confidence
 * @property {object} originalItem - the pre-dedup KrtEntry (without `mergedFrom`)
 */

/**
 * @typedef {object} KrtDetectorMeta
 * @property {'HIGH'|'MEDIUM'|'LOW'} [relevance]    - identifier-scan / Gemini krt_relevance
 * @property {string[]}              [matchedTypes] - identifier-scan
 * @property {number}                [position]     - identifier-scan, char offset
 * @property {object}                [catalogContext]
 * @property {string}                [category]
 * @property {object}                [enrichmentMeta]
 * @property {string}                [text_excerpt] - protocols
 * @property {string}                [context]      - software (Softcite sentence)
 * @property {string}                [version]      - software
 * @property {string}                [creator]      - software
 */

/**
 * Required fields a KrtEntry must carry to survive mergeDetections (which
 * drops entries missing resourceType or both identifier+resourceName).
 */
const REQUIRED_FIELDS = ['resourceType', 'resourceName', 'newReuse'];

/**
 * Lightweight runtime check. Returns an array of issue strings, empty if OK.
 * Used by tests and the snapshot harness to flag drift; production code does
 * not call this (it would just slow things down).
 * @param {object} entry
 * @returns {string[]}
 */
function validateKrtEntry(entry) {
  const issues = [];
  if (!entry || typeof entry !== 'object') {
    return ['not an object'];
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in entry)) issues.push(`missing required field: ${f}`);
  }
  if ('newReuse' in entry && !['new', 'reuse', ''].includes(entry.newReuse)) {
    issues.push(`newReuse must be 'new' | 'reuse' | '', got: ${JSON.stringify(entry.newReuse)}`);
  }
  if ('confidence' in entry && (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1)) {
    issues.push(`confidence must be a number in [0, 1], got: ${JSON.stringify(entry.confidence)}`);
  }
  return issues;
}

/**
 * Deterministic ordering for snapshot diffs. Sorts by
 * (resourceType, resourceName, identifier) — stable for any item shape that
 * carries those fields.
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function sortKrtItems(items) {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    const at = (a?.resourceType || '').toLowerCase();
    const bt = (b?.resourceType || '').toLowerCase();
    if (at !== bt) return at < bt ? -1 : 1;
    const an = (a?.resourceName || '').toLowerCase();
    const bn = (b?.resourceName || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    const ai = (a?.identifier || '').toLowerCase();
    const bi = (b?.identifier || '').toLowerCase();
    if (ai !== bi) return ai < bi ? -1 : 1;
    return 0;
  });
}

module.exports = {
  REQUIRED_FIELDS,
  validateKrtEntry,
  sortKrtItems
};
