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
 * Type + newReuse must still match (case-insensitive, blank-tolerant) — same
 * gate the merger uses, so cross-type collisions can't happen.
 */
function indexKrtForLookup(krtRows) {
  const indexed = krtRows.map(row => {
    const id = row.identifier ?? row['IDENTIFIER'] ?? '';
    const name = row.resourceName ?? row['RESOURCE NAME'] ?? '';
    return {
      row,
      type: String(row.resourceType ?? row['RESOURCE TYPE'] ?? '').toLowerCase().trim(),
      newReuse: String(row.newReuse ?? row['NEW/REUSE'] ?? '').toLowerCase().trim(),
      idTokens: extractIdentifierTokens(id),
      idValue: normalizeRawValue(id),
      nameNorm: normalizeName(name)
    };
  });

  function findMatch(generated) {
    const gType = String(generated.resourceType || '').toLowerCase().trim();
    const gNewReuse = String(generated.newReuse || '').toLowerCase().trim();
    const gTokens = extractIdentifierTokens(generated.identifier);
    const gIdValue = normalizeRawValue(generated.identifier);
    const gName = normalizeName(generated.resourceName);

    for (const entry of indexed) {
      if (entry.type !== gType) continue;
      if (entry.newReuse !== gNewReuse) continue;

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

/**
 * Build the suggestion shape the frontend already consumes.
 */
function makeAddSuggestion(g) {
  return {
    id: `add:${g.dedupKey}`,
    type: 'add_row',
    action: 'add_row',
    status: 'pending',
    source: 'pdf_analysis',
    title: g.resourceName || g.identifier || '(unnamed resource)',
    description: `Add ${g.resourceType}: ${g.resourceName || g.identifier}`,
    detail: g.additionalInformation || null,
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
  COLUMN_MAP
};
