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
 *   3. attachEvidence(items, idx)  → KrtEntry[] (every item TAGGED, none dropped)
 *   4. dedupeKrtItems(items)       → KrtEntry[] (one entry per logical resource)
 *
 * (Stage 3 used to be `enrich<X>` — filling blanks from the curated enrichment
 * lists. That was retired: only identifier_detection consults those lists now,
 * as its data source. Stage 3 is grounding, see evidence.service.js.)
 *
 * Stage 3 no longer DROPS anything. It used to discard an item whose quote it
 * could not locate, which destroyed real findings: the model routinely gets the
 * resource right and the quote wrong (an identifier copied from memory into a
 * sentence that does not occur verbatim). It now records what the detector
 * claimed alongside what was located, and `mergeDetections` is the single place
 * that filters — dropping only `unsupported`, where neither the quote, nor the
 * name, nor the identifier is anywhere in the manuscript.
 */

/**
 * @typedef {object} KrtEntry
 * @property {string} resourceType                  - 'Software/code' | 'Dataset' | 'Protocol' | 'Lab Material' | ...
 * @property {string} resourceName                  - canonical display name
 * @property {string} identifier                    - ';'-joined when multiple
 * @property {string} source                        - URL or curator source string
 * @property {'new'|'reuse'|''} newReuse
 * @property {string} origin                        - detector label ('identifier-scan', 'softcite+list', ...)
 * @property {number} confidence                    - 0..1
 * @property {string} additionalInformation         - snippet / context / "Type: …"
 * @property {KrtEvidence} [evidence]               - where in the manuscript this claim comes from
 * @property {KrtMergeContribution[]} [mergedFrom]  - present after dedupeKrtItems
 * @property {KrtDetectorMeta} [detectorMeta]       - detector-private metadata (UI surfacing only)
 */

/**
 * Where a detection came from in the manuscript. Produced by
 * `evidence.service.js`. Everything in `quote`/`offset`/`section` is VERIFIED
 * against the converted markdown — a quote that does not occur in the document
 * can never appear there. What the detector *asserted* is kept separately, in
 * `claimed`, so an embellished quote stays available for evaluation instead of
 * being silently discarded or silently promoted.
 *
 * @typedef {object} KrtEvidence
 * @property {string} quote                         - text that occurs in the markdown ('' when nothing was located)
 * @property {number} offset                        - char offset into the markdown, -1 when unknown
 * @property {string} section                       - heading path, e.g. 'Methods > Immunohistochemistry'
 * @property {'exact'|'partial'|null} match         - null = nothing located
 * @property {KrtClaimedEvidence} [claimed]         - what the detector asserted, verbatim, before verification
 * @property {KrtMention[]}        [mentions]       - every place the resource occurs, found by search not by the model
 * @property {KrtVerification}     [verification]   - the verdict on the claim
 */

/**
 * The detector's own assertion, preserved exactly as it arrived. Kept so a later
 * evaluation can compare what the model said against what the manuscript says.
 *
 * @typedef {object} KrtClaimedEvidence
 * @property {string} quote
 * @property {string} identifier
 * @property {string} name
 */

/**
 * One occurrence of the resource in the manuscript. Computed deterministically
 * by searching for the name and identifier — NOT reported by the model, which
 * would invent occurrences. Ordered so a usage section precedes the reference
 * list, which is what makes used-vs-cited decidable.
 *
 * @typedef {object} KrtMention
 * @property {number} offset
 * @property {string} section
 * @property {string} quote
 */

/**
 * @typedef {object} KrtVerification
 * @property {'verified'|'embellished'|'unsupported'} status
 *   verified    — the claimed quote occurs in the manuscript
 *   embellished — the quote does not, but the resource (name or identifier) does
 *   unsupported — none of them do; `mergeDetections` drops these
 * @property {boolean} quoteVerbatim
 * @property {boolean} identifierInText
 * @property {boolean} nameInText
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
  if ('evidence' in entry) issues.push(...validateEvidence(entry.evidence));
  return issues;
}

/**
 * Shape check for the evidence block. Does NOT re-verify the quote against the
 * manuscript — that is `evidence.service.js`'s job and needs the document.
 * @param {object} evidence
 * @returns {string[]}
 */
function validateEvidence(evidence) {
  const issues = [];
  if (evidence === null || typeof evidence !== 'object') {
    return ['evidence must be an object'];
  }
  if (typeof evidence.quote !== 'string') issues.push('evidence.quote must be a string');
  if (typeof evidence.offset !== 'number') issues.push('evidence.offset must be a number');
  if (typeof evidence.section !== 'string') issues.push('evidence.section must be a string');
  if (!['exact', 'partial', null].includes(evidence.match)) {
    issues.push(`evidence.match must be 'exact' | 'partial' | null, got: ${JSON.stringify(evidence.match)}`);
  }
  // A grounded match must point somewhere real; an ungrounded one must not
  // pretend to. Catches an offset silently lost in a map/merge.
  if (evidence.match !== null && evidence.offset < 0) {
    issues.push(`evidence.match '${evidence.match}' requires a non-negative offset`);
  }
  return issues;
}

/**
 * Keep only real alternative forms of a resource name: non-empty,
 * de-duplicated, and never a restatement of the canonical name itself.
 *
 * Aliases exist so the grounding step can match the author's wording against
 * the detector's ("Cell Profiler" vs "CellProfiler"). A model that echoes the
 * canonical name back as its own alias produces a field that costs tokens and
 * matches nothing, so those are stripped here rather than in each detector.
 *
 * @param {unknown} aliases
 * @param {string} canonicalName
 * @returns {string[]}
 */
function dedupeAliases(aliases, canonicalName) {
  if (!Array.isArray(aliases)) return [];
  const canonical = String(canonicalName || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const alias of aliases) {
    const value = String(alias || '').trim();
    const key = value.toLowerCase();
    if (!value || key === canonical || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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
  validateEvidence,
  dedupeAliases,
  sortKrtItems
};
