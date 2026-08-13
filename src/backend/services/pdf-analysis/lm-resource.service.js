/**
 * The shared contract for LM detection output.
 *
 * Every LM-backed detector (datasets, materials, protocols, software) used to
 * define its own field vocabulary and its own `buildKrtItems<X>` mapper. The
 * drift was real: `canonical_name` vs `name`, `krt_relevance` vs `relevance`,
 * `evidence_quote` vs `text_excerpt`, and a free-form `detectorMeta` bag with
 * twenty-odd keys across four modules.
 *
 * That cost more than tidiness. When `dedupeKrtItems` silently dropped
 * `evidence`, the same defect produced five different symptoms — invisible on
 * identifier and software (whose `detectorMeta.context` happened to be
 * populated), inconsistent on protocols, and total on datasets and materials.
 * A bug that presents differently per module is a bug you chase five times.
 *
 * ## The contract
 *
 * A detector's LM returns `{ "resources": [ … ] }` where each entry is:
 *
 * ```jsonc
 * {
 *   "name":           "CellProfiler",     // required — the row is dropped without it
 *   "resource_type":  "Software/code",    // per-module vocabulary
 *   "new_reuse":      "new" | "reuse",    // defaults to "reuse"
 *   "source":         "cellprofiler.org", // "" when unknown — never invented
 *   "identifier":     "RRID:SCR_007358",  // "" when unknown — never invented
 *   "evidence_quote": "…verbatim span…",  // verified against the manuscript
 *   "relevance":      "HIGH",             // HIGH | MEDIUM | LOW
 *   "aliases":        ["Cell Profiler"],  // genuine variants only
 *   "details":        { }                 // type-specific extras (version, accessions…)
 * }
 * ```
 *
 * Legacy field names are still accepted (see FIELD_ALIASES) so a prompt that
 * has not been migrated — or data persisted before this contract existed —
 * keeps parsing. A rename can therefore never silently zero a detector.
 */

const { dedupeAliases } = require('./krt-entry');

/** Relevance → confidence, shared so detectors stay comparable when merged. */
const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };
const DEFAULT_CONFIDENCE = 0.7;

/**
 * Canonical field → the older names still accepted, in priority order.
 * Every LM detector's historic vocabulary is represented here, which is what
 * makes migrating the prompts a non-event.
 */
const FIELD_ALIASES = {
  name: ['name', 'canonical_name', 'resourceName'],
  resourceType: ['resource_type', 'resourceType'],
  newReuse: ['new_reuse', 'newReuse'],
  source: ['source'],
  identifier: ['identifier'],
  evidenceQuote: ['evidence_quote', 'text_excerpt', 'evidenceQuote'],
  relevance: ['relevance', 'krt_relevance'],
  aliases: ['aliases']
};

/**
 * Read the first present alias for a canonical field.
 * @param {object} raw - one LM resource entry
 * @param {string} field - a FIELD_ALIASES key
 * @returns {*}
 */
function readField(raw, field) {
  for (const key of FIELD_ALIASES[field] || []) {
    const value = raw?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/**
 * Map one LM resource entry to the canonical KrtEntry shape.
 *
 * @param {object} raw - one entry from the LM's `resources` array
 * @param {object} options
 * @param {string} options.origin - detector label ('materials-gemini', …)
 * @param {string} [options.defaultResourceType] - used when the entry omits one
 * @param {(raw:object)=>object} [options.details] - type-specific extras for detectorMeta
 * @returns {object|null} a KrtEntry, or null when the entry has no usable name
 */
function buildKrtItemFromLM(raw, { origin, defaultResourceType = '', details } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(readField(raw, 'name') || '').trim();
  if (!name) return null;

  const relevance = String(readField(raw, 'relevance') || 'MEDIUM').toUpperCase();
  const newReuseRaw = String(readField(raw, 'newReuse') || '').toLowerCase();

  return {
    resourceType: String(readField(raw, 'resourceType') || defaultResourceType).trim(),
    resourceName: name,
    identifier: String(readField(raw, 'identifier') || '').trim(),
    source: String(readField(raw, 'source') || '').trim(),
    // "new" is the exception, not the default: most resources are third-party,
    // and every detector's prompt says to fall back to reuse when uncertain.
    newReuse: newReuseRaw === 'new' ? 'new' : 'reuse',
    origin,
    confidence: RELEVANCE_TO_CONFIDENCE[relevance] ?? DEFAULT_CONFIDENCE,
    // Kept empty on purpose: ADDITIONAL INFORMATION is the author's column, and
    // detector context belongs in detectorMeta / evidence instead.
    additionalInformation: '',
    // Unresolved evidence. attachEvidence verifies the quote against the
    // manuscript and fills offset/section/match/context — or drops the row.
    evidence: {
      quote: String(readField(raw, 'evidenceQuote') || '').trim(),
      offset: -1,
      section: '',
      match: null
    },
    detectorMeta: {
      relevance,
      aliases: dedupeAliases(readField(raw, 'aliases'), name),
      ...(typeof details === 'function' ? (details(raw) || {}) : {})
    }
  };
}

/**
 * Map an LM `resources` array to KrtEntry[]. Entries without a name are
 * dropped — a resource we cannot name is not a row a curator can act on.
 *
 * @param {object[]} rawItems
 * @param {object} options - see buildKrtItemFromLM
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsFromLM(rawItems, options = {}) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((raw) => buildKrtItemFromLM(raw, options)).filter(Boolean);
}

module.exports = {
  RELEVANCE_TO_CONFIDENCE,
  DEFAULT_CONFIDENCE,
  FIELD_ALIASES,
  readField,
  buildKrtItemFromLM,
  buildKrtItemsFromLM
};
