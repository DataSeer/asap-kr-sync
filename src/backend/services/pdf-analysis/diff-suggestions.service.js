/**
 * Compute the suggestion list shown to the user as a diff between the
 * Generated KRT (output of mergeDetections) and the user's KRT (krt_data).
 *
 * Pure function — no DB, no async, no I/O.
 *
 * Inputs:
 *   generated:        Array<GeneratedResource>     (from mergeDetections)
 *   krtRows:          Array<KrtRow>                 (user's current KRT)
 *   rejectedAddSet:   Set<string>                   (dedup_keys with rejected 'add')
 *   rejectedColumns:  Map<string, Set<string>>      (dedup_key → set of column-name rejections)
 *
 * Output:
 *   Array<Suggestion>   (shape matches the existing /suggestions API contract)
 */

const {
  extractIdentifierTokens,
  normalizeRawValue,
  normalizeName,
  identifiersMatch
} = require('./identifier-normalize.service');
const { normalizeResourceTypeKey } = require('./merge-detections.service');

const KRT_COLUMNS = [
  'resourceType',
  'resourceName',
  'source',
  'identifier',
  'newReuse',
  'additionalInformation'
];

// Map between the GeneratedResource camelCase fields, the KRT row's persisted
// snake_case fields, and the suggestion-data field names the frontend expects.
const COLUMN_MAP = {
  resourceType: { krt: 'resourceType', label: 'RESOURCE TYPE', generatedField: 'resourceType' },
  resourceName: { krt: 'resourceName', label: 'RESOURCE NAME', generatedField: 'resourceName' },
  source:       { krt: 'source',       label: 'SOURCE',         generatedField: 'sourceUrl' },
  identifier:   { krt: 'identifier',   label: 'IDENTIFIER',     generatedField: 'identifier' },
  newReuse:     { krt: 'newReuse',     label: 'NEW/REUSE',      generatedField: 'newReuse' },
  additionalInformation: {
    krt: 'additionalInformation',
    label: 'ADDITIONAL INFORMATION',
    generatedField: 'additionalInformation'
  }
};

/**
 * Index user KRT rows for alias-aware lookup against generated resources.
 *
 * Strict dedupKey-equality matching misses common cases where user and
 * detector describe the same resource through different aliases:
 *
 *   user wrote "ImageJ" with no identifier
 *   detector found "ImageJ" with "RRID:SCR_003070"
 *   → dedupKeys diverge ("name:imagej" vs "rrid:scr_003070") → spurious "add"
 *
 * Mirroring `mergeDetections.shouldMerge`, each row gets the union of every
 * identifier-token, opaque normalized identifier, and normalized name it
 * exposes. Lookup tests intersection on any of those axes.
 *
 * Type must still match (case-insensitive, blank-tolerant) so cross-type
 * collisions can't happen. newReuse is NOT a match gate: the user may have
 * marked a resource as NEW (they generated it) while the detector cites the
 * same identifier as a reuse from references — both refer to the same row.
 */
function indexKrtForLookup(krtRows) {
  const indexed = krtRows.map(row => {
    const id = row.identifier ?? row['IDENTIFIER'] ?? '';
    const name = row.resourceName ?? row['RESOURCE NAME'] ?? '';
    return {
      row,
      // Same normalization mergeDetections.shouldMerge uses, so e.g. a
      // user row "Code/Software" matches a generated entry "Software/code".
      type: normalizeResourceTypeKey(row.resourceType ?? row['RESOURCE TYPE'] ?? ''),
      idTokens: extractIdentifierTokens(id),
      idValue: normalizeRawValue(id),
      nameNorm: normalizeName(name)
    };
  });

  function findMatch(generated) {
    const gType = normalizeResourceTypeKey(generated.resourceType);
    const gTokens = extractIdentifierTokens(generated.identifier);
    const gIdValue = normalizeRawValue(generated.identifier);
    const gName = normalizeName(generated.resourceName);

    for (const entry of indexed) {
      if (entry.type !== gType) continue;

      // Identifier-token intersection
      for (const tok of gTokens) {
        if (entry.idTokens.has(tok)) return entry.row;
      }
      // Opaque-id match (covers one-side-structured / one-side-bare)
      if (gIdValue && entry.idValue && gIdValue === entry.idValue) return entry.row;
      if (gIdValue && entry.idTokens.size > 0) {
        for (const tok of entry.idTokens) {
          if (tok.slice(tok.indexOf(':') + 1) === gIdValue) return entry.row;
        }
      }
      if (entry.idValue && gTokens.size > 0) {
        for (const tok of gTokens) {
          if (tok.slice(tok.indexOf(':') + 1) === entry.idValue) return entry.row;
        }
      }
      // Name match
      if (gName && entry.nameNorm && gName === entry.nameNorm) return entry.row;
    }
    return null;
  }

  return { findMatch };
}

/**
 * Lookup table that handles BOTH the camelCase shape (KRTData model output)
 * and the uppercase KRT-column shape that some code paths use.
 */
function getKrtField(row, fieldKey) {
  const colMeta = COLUMN_MAP[fieldKey];
  if (!colMeta) return undefined;
  return row[colMeta.krt] ?? row[colMeta.label];
}

/**
 * Two values are considered the "same" for diff purposes when their
 * trimmed strings compare equal (case-sensitive, since KRT values like
 * RRIDs and DOIs are typically case-significant). Empty/null treated equal.
 */
function valuesEqual(a, b) {
  const sa = a == null ? '' : String(a).trim();
  const sb = b == null ? '' : String(b).trim();
  return sa === sb;
}

/**
 * Column-aware equality. For the identifier column we use the same matcher
 * the merger relies on, so cosmetic differences (`AB_X` vs `RRID: AB_X`,
 * `https://doi.org/10.x` vs `10.x`) don't surface as noise edit suggestions.
 * Other columns fall back to trimmed string equality.
 */
function fieldEqual(fieldKey, oldVal, newVal) {
  if (fieldKey === 'identifier') {
    if (valuesEqual(oldVal, newVal)) return true;
    return identifiersMatch(oldVal || '', newVal || '');
  }
  return valuesEqual(oldVal, newVal);
}

// Common words that don't add information to a resource name — used by the
// lossy-rename guard to decide whether a rename actually changes meaning.
// Short list of high-frequency English / KRT filler; intentionally narrow so
// it doesn't strip discriminative tokens by accident.
const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'for', 'in', 'on', 'to', 'with',
  'antibody', 'reagent', 'kit', 'software', 'tool'
]);

/**
 * Split a resource name into normalized informative tokens. Lowercased, with
 * non-alphanumeric stripped and stopwords removed. Used by isLossyRename().
 */
function nameTokens(value) {
  if (!value) return new Set();
  const lc = String(value).toLowerCase();
  const tokens = lc.split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(tokens.filter(t => t.length >= 2 && !NAME_STOPWORDS.has(t)));
}

/**
 * Whether proposing `newName` in place of `oldName` would lose information
 * or change the entity entirely. Used to suppress noise resourceName EDIT
 * suggestions that come from the curated DB's canonicalization picking a
 * shorter / target-protein name over the user's more specific entry.
 *
 * Returns true (= suppress) when any of:
 *   1. newName, after normalization, is a substring of oldName — the
 *      proposed rename drops trailing/leading qualifiers
 *      ("Sprague-Dawley rats" → "Sprague-Dawley").
 *   2. newName's informative tokens are a strict subset of oldName's, AND
 *      newName has fewer of them — strictly less specific
 *      ("Rabbit anti-TH" → "Anti-TH").
 *   3. The two names share NO informative tokens — almost certainly a
 *      different entity ("Sheep anti-TH" → "tyrosine hydroxylase"). The
 *      strongest signal that the curated DB conflated unrelated rows.
 *   4. The only difference is case / whitespace / punctuation — cosmetic,
 *      not worth surfacing.
 *   5. The rename drops MORE informative tokens than it adds (partial
 *      paraphrase where the curated canonical lost qualifiers). Example:
 *      "Monoclonal Mouse Anti-tubulin-βIII" → "a-Tubulin beta III" —
 *      old uniquely had {monoclonal, mouse, anti}; new uniquely has {beta}.
 *      3 dropped vs 1 added → net info loss → suppress.
 *
 * Conservative on purpose: when in doubt, we'd rather drop a marginal
 * suggestion than show the user a confusing or wrong one.
 */
function isLossyRename(oldName, newName) {
  const oldStr = String(oldName ?? '').trim();
  const newStr = String(newName ?? '').trim();
  if (!newStr) return true;                              // nothing to propose
  if (!oldStr) return false;                             // user has no name; any name is an improvement

  // Rule 4: cosmetic-only difference (case/whitespace/punctuation).
  const oldNorm = oldStr.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const newNorm = newStr.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (oldNorm === newNorm) return true;

  // Rule 1: new is a substring of old (info dropped).
  // Compare on lowercase / collapsed whitespace so "Sprague-Dawley rats" →
  // "Sprague-Dawley" trips even with case-only padding differences.
  const oldLc = oldStr.toLowerCase().replace(/\s+/g, ' ');
  const newLc = newStr.toLowerCase().replace(/\s+/g, ' ');
  if (oldLc.includes(newLc) && newLc.length < oldLc.length) return true;

  const oldToks = nameTokens(oldStr);
  const newToks = nameTokens(newStr);

  // Rules 2, 3, 5 — all token-based. Only fire when both sides have
  // informative tokens (otherwise we'd suppress every "Anti-TH" replacement
  // for a single-letter name).
  if (oldToks.size > 0 && newToks.size > 0) {
    let overlap = 0;
    for (const t of newToks) if (oldToks.has(t)) overlap++;

    // Rule 3: zero overlap → different entity.
    if (overlap === 0) return true;

    // Rule 2: strict subset AND fewer tokens — drops info without adding any.
    if (newToks.size < oldToks.size) {
      let allInOld = true;
      for (const t of newToks) if (!oldToks.has(t)) { allInOld = false; break; }
      if (allInOld) return true;
    }

    // Rule 5: partial paraphrase that drops more tokens than it adds.
    const uniqueToOld = oldToks.size - overlap;
    const uniqueToNew = newToks.size - overlap;
    if (uniqueToOld > uniqueToNew) return true;
  }

  return false;
}

/**
 * Pull the most informative manuscript excerpt from the merged contributors.
 * Surfacing this to the user (request #21/#22/#23) lets them verify a
 * suggestion against the actual paper text instead of guessing where it came
 * from. Falls back through context → text_excerpt → catalogContext on each
 * detectedBy entry, picks the first non-empty one. Returns null if every
 * contributor was empty — common for datasets today; will improve once the
 * datasets prompt is updated to return excerpts too.
 */
function getEvidence(g) {
  if (!Array.isArray(g?.detectedBy)) return null;
  for (const entry of g.detectedBy) {
    const meta = entry?.originalItem?.detectorMeta || {};
    const candidate = meta.context || meta.text_excerpt || meta.catalogContext;
    if (candidate && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }
  return null;
}

/**
 * Build the suggestion shape the frontend already consumes.
 */
function makeAddSuggestion(g) {
  const evidence = getEvidence(g);
  return {
    id: `add:${g.dedupKey}`,
    type: 'add_row',
    action: 'add_row',
    status: 'pending',
    source: 'pdf_analysis',
    title: g.resourceName || g.identifier || '(unnamed resource)',
    description: `Add ${g.resourceType}: ${g.resourceName || g.identifier}`,
    // detail/evidence carry the manuscript snippet that justified the
    // suggestion, surfaced in the carousel's "More details" expand.
    detail: g.additionalInformation || evidence || null,
    evidence,
    confidence: g.confidence || 0,
    existsInKRT: 'false',
    matchedKrtRowId: null,
    data: {
      resourceType: g.resourceType,
      resourceName: g.resourceName,
      source: g.sourceUrl,
      identifier: g.identifier,
      newReuse: g.newReuse,
      additionalInformation: g.additionalInformation
    },
    mergedFrom: g.detectedBy
  };
}

function makeEditSuggestion(g, krtRow, fieldKey, oldValue, newValue) {
  const colMeta = COLUMN_MAP[fieldKey];
  return {
    id: `edit:${g.dedupKey}:${fieldKey}`,
    type: 'edit',
    action: 'edit',
    status: 'pending',
    source: 'pdf_analysis',
    title: `Update ${colMeta.label} of ${g.resourceName || g.identifier}`,
    description: `${colMeta.label}: "${oldValue || '(empty)'}" → "${newValue}"`,
    detail: null,
    confidence: g.confidence || 0,
    existsInKRT: 'update',
    matchedKrtRowId: krtRow.id,
    data: {
      rowId: krtRow.id,
      column: fieldKey,
      columnLabel: colMeta.label,
      oldValue: oldValue ?? '',
      newValue,
      resourceType: g.resourceType,
      resourceName: g.resourceName,
      source: g.sourceUrl,
      identifier: g.identifier,
      newReuse: g.newReuse,
      additionalInformation: g.additionalInformation
    },
    mergedFrom: g.detectedBy
  };
}

/**
 * Compute suggestions.
 */
function computeSuggestions(generated, krtRows, rejectedAddSet = new Set(), rejectedColumns = new Map()) {
  if (!Array.isArray(generated)) generated = [];
  if (!Array.isArray(krtRows))   krtRows   = [];

  const krtIndex = indexKrtForLookup(krtRows);
  const suggestions = [];

  for (const g of generated) {
    if (!g.dedupKey) continue;
    const matched = krtIndex.findMatch(g);

    if (!matched) {
      // Resource is in the Generated KRT but not in the user's KRT → "add".
      if (rejectedAddSet.has(g.dedupKey)) continue;
      suggestions.push(makeAddSuggestion(g));
      continue;
    }

    // Match found → compare per-column. Resource_type and new_reuse are part
    // of dedup_key so they always match. Compare the remaining fields.
    const editableColumns = ['resourceName', 'source', 'identifier', 'additionalInformation'];
    const colReject = rejectedColumns.get(g.dedupKey) || new Set();

    for (const fieldKey of editableColumns) {
      if (colReject.has(fieldKey)) continue;
      const colMeta = COLUMN_MAP[fieldKey];
      const newValue = g[colMeta.generatedField] ?? '';
      const oldValue = getKrtField(matched, fieldKey) ?? '';
      // Don't suggest blanking out a non-empty user value.
      if (!String(newValue).trim()) continue;
      if (fieldEqual(fieldKey, oldValue, newValue)) continue;
      // Per ASAP request: enrichment/detection should not aggressively
      // overwrite SOURCE values the user already filled in. Only suggest a
      // SOURCE edit when the user's cell is empty. Other columns can still
      // surface edit suggestions normally because they're typically
      // corrections (typos, missing RRID, etc.) the user welcomes.
      if (fieldKey === 'source' && String(oldValue).trim() !== '') continue;
      // Lossy-rename guard. The identifier scanner emits the curated DB's
      // canonical resourceName for any RRID/DOI it matches. When that name
      // is shorter, less specific, or a different entity than the user's
      // name, surfacing it as an edit confuses more than it helps
      // ("Rabbit anti-TH" → "Anti-TH", "Sheep anti-TH" → "tyrosine
      // hydroxylase"). Skip these — user-side names always win when the
      // proposed replacement loses information or changes meaning.
      if (fieldKey === 'resourceName' && isLossyRename(oldValue, newValue)) continue;
      suggestions.push(makeEditSuggestion(g, matched, fieldKey, oldValue, newValue));
    }
  }

  return suggestions;
}

/**
 * Parse a synthetic suggestion ID back into its parts. Returns null on parse
 * failure.
 */
function parseSuggestionId(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('add:')) {
    return { kind: 'add', dedupKey: id.slice('add:'.length) };
  }
  if (id.startsWith('edit:')) {
    const rest = id.slice('edit:'.length);
    // dedup_key may itself contain ':', but column never does.
    const idx = rest.lastIndexOf(':');
    if (idx === -1) return null;
    return {
      kind: 'edit',
      dedupKey: rest.slice(0, idx),
      column: rest.slice(idx + 1)
    };
  }
  return null;
}

module.exports = {
  computeSuggestions,
  parseSuggestionId,
  indexKrtForLookup,
  isLossyRename,
  COLUMN_MAP
};
