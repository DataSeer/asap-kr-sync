/**
 * Identifier normalization for cross-source dedup.
 *
 * Detection sources put identifiers in many shapes:
 *   "https://doi.org/10.5281/zenodo.X"
 *   "DOI: 10.5281/zenodo.X."
 *   "RRID: AB_2744623"
 *   "Cat#: N0502-At488-L ; RRID: AB_2744623"
 *   "10.5281/zenodo.X; https://doi.org/Y"
 *
 * For dedup we need to know whether two raw fields refer to the same resource.
 * This module:
 *
 *   1. Pulls every identifier out of a raw field as a TYPED set of tokens
 *      (via the existing identifier-extractor module).
 *   2. Normalizes each token (lowercase, strip protocol/prefix/punctuation).
 *   3. Compares two sets by intersection — non-empty intersection ⇒ match.
 *
 * Type-tagging matters: "10.5281/X" parsed as DOI must NOT collide with
 * "10.5281/X" parsed as a catalog number, etc. Tokens carry their type:
 * "doi:10.5281/x", "rrid:ab_2744623", "name:foo".
 */

const identifierExtractor = require('../krt/identifier-extractor');

/**
 * Normalize a single raw value: lowercase, strip leading/trailing
 * punctuation and protocol/prefix noise. Used for individual extracted
 * identifiers AND as a fallback when the field doesn't yield any structured
 * identifier (we still want to compare two opaque strings sensibly).
 */
function normalizeRawValue(value) {
  if (value == null) return '';
  let s = String(value).toLowerCase().trim();

  // Repeatedly strip prefix/suffix noise until stable.
  // NOTE: each prefix replacement must REDUCE the string length (or be a
  // no-op) — replacements that grow the string can loop forever (e.g. an
  // earlier "scr ... → scr_" rule on an input that already started "scr_").
  let prev;
  let iter = 0;
  do {
    prev = s;
    s = s
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/^doi\.org\//, '')
      .replace(/^doi[\s:.-]+/, '')
      .replace(/^rrid[\s:.-]+/, '')
      // 'scr: 002798' → 'scr_002798'. Safe: requires at least one whitespace/
      // separator char after 'scr', so 'scr_X' (already underscored) doesn't
      // match and we avoid the previous infinite-loop trap.
      .replace(/^scr[\s:.-]+/, 'scr_')
      .replace(/^addgene[\s:.-]+/, '')
      .replace(/^cat[\s#.]*[\s:.-]+/, '')
      .replace(/^pmid[\s:.-]+/, '')
      .replace(/[\s.,;/]+$/, '')
      .trim();
    if (++iter > 8) break; // safety cap; never fires in practice
  } while (s !== prev);

  // Collapse internal whitespace
  s = s.replace(/\s+/g, ' ');
  return s;
}

/**
 * Normalize a resource name: lowercase + collapse whitespace + strip
 * surrounding punctuation. Used for name-based dedup matching.
 */
function normalizeName(name) {
  if (name == null) return '';
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/^[\s\-_(){}[\]"'.,;:]+|[\s\-_(){}[\]"'.,;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Extract every identifier present in a raw field as a Set of typed tokens.
 * Each token is `<type>:<normalized-value>`.
 *
 *   "Cat #: N0502 ; RRID: AB_2744623"
 *     → { "rrid:ab_2744623", "catalog:n0502" }
 *
 *   "https://doi.org/10.5281/zenodo.X"
 *     → { "doi:10.5281/zenodo.x" }
 *
 *   "" → empty set
 */
function extractIdentifierTokens(raw) {
  const out = new Set();
  if (!raw) return out;

  const extracted = identifierExtractor.extractAll(String(raw));
  // identifier-extractor returns the FIRST match for each type as a string,
  // or null. We treat each non-null entry as a typed token.
  const TYPE_KEYS = [
    'doi', 'rrid', 'scr', 'emdb', 'pdb', 'empiar', 'cellosaurus',
    'addgene', 'url', 'catalogNumber', 'pmid', 'genbank', 'uniprot'
  ];
  for (const key of TYPE_KEYS) {
    const value = extracted[key];
    if (!value) continue;
    const norm = normalizeRawValue(value);
    if (!norm) continue;
    // 'catalogNumber' → 'catalog' for shorter token
    const type = key === 'catalogNumber' ? 'catalog' : key;
    out.add(`${type}:${norm}`);
  }
  return out;
}

/**
 * Two raw identifier fields match if any of these conditions hold:
 *
 *   1. Both produce structured tokens and the sets intersect:
 *        e.g. "RRID: AB_X" vs "rrid:ab_x" → token sets share rrid:ab_x
 *   2. Both produce no tokens, but their opaque normalized strings match:
 *        e.g. "PRJEB1234" vs "prjeb1234"
 *   3. One produces tokens, the other doesn't, but the opaque normalized
 *      string of the latter matches the value of one of the former's tokens:
 *        e.g. "Cat#: N1; RRID: AB_X" vs "AB_X"
 *      This is the common case where one detector emits a fully-formatted
 *      identifier and another emits the bare ID, and they should still
 *      collapse.
 */
function identifiersMatch(a, b) {
  const ta = extractIdentifierTokens(a);
  const tb = extractIdentifierTokens(b);

  // Case 1: both have tokens
  if (ta.size > 0 && tb.size > 0) {
    for (const tok of ta) {
      if (tb.has(tok)) return true;
    }
    return false;
  }

  // Case 2: both empty → opaque equality
  if (ta.size === 0 && tb.size === 0) {
    const na = normalizeRawValue(a);
    const nb = normalizeRawValue(b);
    return na !== '' && na === nb;
  }

  // Case 3: one side structured, the other opaque
  const tokens = ta.size > 0 ? ta : tb;
  const opaqueNorm = normalizeRawValue(ta.size === 0 ? a : b);
  if (!opaqueNorm) return false;
  for (const tok of tokens) {
    const value = tok.slice(tok.indexOf(':') + 1);
    if (value === opaqueNorm) return true;
  }
  return false;
}

/**
 * Two resource names match (case-insensitive, whitespace-tolerant).
 */
function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na !== '' && na === nb;
}

/**
 * Stable dedup key for a resource. Used as the unique identity for
 * rejected-resources rows and for synthetic suggestion IDs. Order matters:
 *
 *   resourceType | newReuse | (firstIdentifierToken OR "name:" + normName)
 *
 * If multiple identifier tokens exist, pick the lexicographically smallest
 * for stability across re-runs.
 */
function computeDedupKey(resource) {
  const type = String(resource.resourceType || resource.resource_type || '').toLowerCase().trim();
  const newReuse = String(resource.newReuse || resource.new_reuse || '').toLowerCase().trim();
  const idField = resource.identifier ?? resource.IDENTIFIER ?? '';
  const nameField = resource.resourceName ?? resource.resource_name ?? resource.RESOURCE_NAME ?? '';

  const tokens = [...extractIdentifierTokens(idField)].sort();
  let tail;
  if (tokens.length > 0) {
    tail = tokens[0]; // smallest typed token
  } else {
    const name = normalizeName(nameField);
    if (!name) {
      // No structured id, no name — fall back to normalized raw id, or empty.
      const rawNorm = normalizeRawValue(idField);
      tail = rawNorm ? `raw:${rawNorm}` : 'unknown';
    } else {
      tail = `name:${name}`;
    }
  }
  return `${type}|${newReuse}|${tail}`;
}

module.exports = {
  normalizeRawValue,
  normalizeName,
  extractIdentifierTokens,
  identifiersMatch,
  namesMatch,
  computeDedupKey
};
