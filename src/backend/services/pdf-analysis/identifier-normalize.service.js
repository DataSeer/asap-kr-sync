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
/**
 * Canonicalize resourceType strings so synonyms collapse onto one key in
 * dedup / merge / lookup paths. Today this only matters for the
 * "Code/Software" ↔ "Software/code" pair — the EnrichmentListEntry table
 * still uses the historic label while submissions use the renamed form,
 * and we want both to land on a single bar. Other types pass through
 * lowercased+trimmed.
 */
function normalizeResourceTypeKey(value) {
  const lc = String(value ?? '').toLowerCase().trim();
  if (!lc) return '';
  if (lc === 'code/software' || lc === 'software/code' || lc === 'code' || lc === 'software') {
    return 'software/code';
  }
  return lc;
}

/**
 * Display-form canonical resourceType. Like normalizeResourceTypeKey but
 * returns the title-case label the rest of the app uses ("Software/code")
 * instead of the lowercase merge key. Use this at emission boundaries —
 * detectors / scanners — so DB rows that still carry the historic
 * "Code/Software" spelling land on the KRT as "Software/code".
 *
 * Returns the input trimmed unchanged when no canonicalisation applies,
 * so unfamiliar resourceTypes (Antibody, Recombinant DNA, etc.) pass
 * through cleanly.
 */
function canonicalResourceType(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const lc = raw.toLowerCase();
  if (lc === 'code/software' || lc === 'software/code' || lc === 'code' || lc === 'software') {
    return 'Software/code';
  }
  return raw;
}

/**
 * Allowlist for inferring a KRT SOURCE from an identifier alone.
 *
 * Philosophy (mirrors the protocol-finder convention): allowlist-ONLY, and
 * never guess. Each rule maps an UNAMBIGUOUS identifier shape — a repository
 * URL host, a registered DOI prefix, or a structured accession namespace — to
 * the canonical source name a curator would type. Anything that isn't a
 * high-confidence, prefix-unique match yields `null`.
 *
 * Deliberately OMITTED because the identifier alone is insufficient:
 *   - Journal DOIs (10.1101/… bioRxiv, 10.1038/… Nature, 10.1371/… PLOS …):
 *     the prefix is shared by every article from that publisher.
 *   - 4-char PDB IDs, bare GenBank/UniProt accessions: too collision-prone.
 *   - Zenodo-hosted software releases whose canonical home is GitHub: handled
 *     by the conflict rule below (a string matching two distinct sources →
 *     null), so we never invent a worse answer than the user would.
 *
 * Adding a source is a one-line entry here. `pattern` MUST NOT use the `g`
 * flag (we call .test() repeatedly and `g` is stateful).
 *
 * Each rule carries a `kind`:
 *   'url' — matched a repository/host URL
 *   'id'  — matched a DOI prefix or a structured accession
 * This drives conflict resolution in inferSourceFromIdentifier: a DOI/accession
 * source outranks a URL source, because the registered/persistent identifier is
 * the more authoritative pointer (e.g. a Zenodo DOI is preferred over a GitHub
 * URL that appears alongside it).
 */
const SOURCE_INFERENCE_RULES = [
  // --- Code repositories (URL host) ---
  { source: 'GitHub',            kind: 'url', pattern: /\bgithub\.com\//i },
  { source: 'GitLab',            kind: 'url', pattern: /\bgitlab\.com\//i },
  { source: 'Bitbucket',         kind: 'url', pattern: /\bbitbucket\.org\//i },

  // --- General-purpose data repositories (URL host) ---
  { source: 'Zenodo',            kind: 'url', pattern: /\bzenodo\.org\//i },
  { source: 'Dryad',             kind: 'url', pattern: /\bdatadryad\.org\//i },
  { source: 'figshare',          kind: 'url', pattern: /\bfigshare\.com\//i },
  { source: 'Open Science Framework', kind: 'url', pattern: /\bosf\.io\//i },
  { source: 'protocols.io',      kind: 'url', pattern: /\bprotocols\.io\//i },

  // --- General-purpose data repositories (DOI prefix) ---
  { source: 'Zenodo',            kind: 'id',  pattern: /10\.5281\/zenodo\./i },
  { source: 'Dryad',             kind: 'id',  pattern: /10\.5061\/dryad\./i },
  { source: 'figshare',          kind: 'id',  pattern: /10\.6084\/m9\.figshare\./i },
  { source: 'protocols.io',      kind: 'id',  pattern: /10\.17504\/protocols\.io\./i },

  // --- Sequence / omics archives (structured accession) ---
  { source: 'NCBI GEO',          kind: 'id',  pattern: /\bG(?:SE|SM|PL|DS)\d+\b/i },
  { source: 'NCBI SRA',          kind: 'id',  pattern: /\bSR[RXPS]\d+\b/i },
  { source: 'NCBI BioProject',   kind: 'id',  pattern: /\bPRJ[NED][A-Z]\d+\b/i },
  { source: 'NCBI BioSample',    kind: 'id',  pattern: /\bSAM[NED][A-Z]?\d+\b/i },
  { source: 'dbGaP',             kind: 'id',  pattern: /\bphs\d{6}\b/i },
  { source: 'ArrayExpress',      kind: 'id',  pattern: /\bE-[A-Z]{4}-\d+\b/i },
  { source: 'ProteomeXchange',   kind: 'id',  pattern: /\bPXD\d+\b/i },

  // --- Structural biology archives ---
  { source: 'EMPIAR',            kind: 'id',  pattern: /\bEMPIAR-\d+\b/i },
  { source: 'EMDB',              kind: 'id',  pattern: /\bEMDB?-\d+\b/i },

  // --- Plasmid repository ---
  { source: 'Addgene',           kind: 'id',  pattern: /\baddgene[_\s#:]*\d+/i }
];

/**
 * Infer the canonical KRT SOURCE from an identifier string, allowlist-only.
 *
 * Returns the source name (e.g. 'GitHub', 'Zenodo', 'NCBI GEO') or `null` when
 * the identifier is unknown or genuinely ambiguous. The identifier may be a
 * URL, a DOI, a bare accession, or a ';'-joined combination.
 *
 * Resolution order:
 *   1. DOI/accession-derived sources take precedence over URL-derived sources
 *      (the registered identifier is the more authoritative pointer).
 *      Exactly one distinct DOI/accession source → return it.
 *   2. Two or more distinct DOI/accession sources → null (ambiguous).
 *   3. No DOI/accession signal: exactly one distinct URL source → return it.
 *   4. Otherwise → null (unknown, or two distinct URL hosts).
 *
 * @param {string} identifier
 * @returns {string|null}
 */
function inferSourceFromIdentifier(identifier) {
  if (!identifier) return null;
  const s = String(identifier);

  const urlSources = new Set();
  const idSources = new Set();
  for (const rule of SOURCE_INFERENCE_RULES) {
    if (!rule.pattern.test(s)) continue;
    (rule.kind === 'url' ? urlSources : idSources).add(rule.source);
  }

  // DOI/accession beats URL on conflict (registered identifier is authoritative).
  if (idSources.size === 1) return [...idSources][0];
  if (idSources.size > 1) return null;
  // No DOI/accession signal — fall back to the URL sources.
  return urlSources.size === 1 ? [...urlSources][0] : null;
}

function computeDedupKey(resource) {
  const type = normalizeResourceTypeKey(resource.resourceType || resource.resource_type || '');
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
  normalizeResourceTypeKey,
  canonicalResourceType,
  inferSourceFromIdentifier,
  extractIdentifierTokens,
  identifiersMatch,
  namesMatch,
  computeDedupKey
};
