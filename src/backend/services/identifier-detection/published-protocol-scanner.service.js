/**
 * Published-protocol scanner.
 *
 * Sweeps text (markdown converted from a PDF) for identifiers that PROVE, on
 * their own, that they point at a published protocol — a methods work issued by
 * a recognized protocol-publishing venue (protocols.io, Nature Protocols, JoVE,
 * Bio-protocol, STAR Protocols, …).
 *
 * Complements known-identifier-scanner.service.js rather than overlapping it:
 * that one only fires on identifiers already present in the curated enrichment
 * lists, so a Nature Protocols DOI sitting in a Methods paragraph that nobody
 * ever curated is invisible to it. This sweep is list-free — it recognizes the
 * VENUE from the identifier shape alone.
 *
 * Zero-false-positive by design. The venue catalog lives in ONE place
 * (SOURCE_INFERENCE_RULES in identifier-normalize.service.js, tagged
 * `venue: 'protocol'`); this module does not carry its own patterns. It only
 * extracts DOI/URL candidates and asks that catalog to name the venue, so an
 * ambiguous identifier — a bare PLOS or Springer DOI, a string matching two
 * distinct sources — resolves to null and is silently dropped. Missing a
 * protocol is acceptable; labelling a non-protocol DOI as one is not.
 *
 * What it deliberately does NOT infer:
 *   - resourceName: the identifier carries no title. Rows are emitted nameless
 *     and rely on the consolidator to fold them into a named contributor.
 *   - newReuse: a venue identifier says WHERE a protocol was published, not
 *     whether this study authored it. Authors routinely deposit their own NEW
 *     protocol on protocols.io / Protocol Exchange alongside the paper.
 *
 * Pure functions — no DB, no async, no I/O.
 */

const {
  inferSourceFromIdentifier,
  isProtocolVenueSource,
  normalizeRawValue
} = require('../pdf-analysis/identifier-normalize.service');

// Candidate extraction patterns. These intentionally mirror the `doi` and `url`
// entries of STRUCTURED_PATTERNS in known-identifier-scanner.service.js — they
// are duplicated rather than shared because both modules mutate `lastIndex` on
// their own sweeps, and sharing one stateful /g regex between two scanners is a
// silent-skip bug waiting to happen. Keep the two in sync if either changes.
const CANDIDATE_PATTERNS = [
  { type: 'doi', re: /\b10\.\d{4,9}\/[^\s,;)\]]+/gi },
  { type: 'url', re: /https?:\/\/[^\s,;)\]<>"]+/gi }
];

// Trailing sentence punctuation that must not be swallowed into an identifier
// when the match ends a sentence or sits inside parentheses:
//   "…as described (10.1038/nprot.2009.97)." → "10.1038/nprot.2009.97"
const TRAILING_PUNCTUATION_RE = /[.,;:)\]}>'"]+$/;

/**
 * Trim trailing sentence punctuation from a raw identifier match.
 *
 * Unlike normalizeRawValue this preserves case and the URL scheme, because the
 * result goes into a user-facing KRT IDENTIFIER cell — "https://www.nature.com/
 * articles/nprot.2009.97" must not degrade to "nature.com/articles/...".
 *
 * @param {string} raw
 * @returns {string}
 */
function trimIdentifier(raw) {
  return String(raw ?? '').trim().replace(TRAILING_PUNCTUATION_RE, '');
}

/**
 * Scan text for published-protocol identifiers.
 *
 * One match per distinct identifier (repeat mentions collapse onto the first
 * occurrence, which is the position reported).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.cutoff=-1] - char offset to truncate at (references
 *   heading), or -1 to scan the whole text. The caller owns cutoff detection so
 *   this module stays free of document-structure knowledge.
 * @returns {{ matches: Array<{identifier: string, source: string, type: string,
 *   position: number}>, scannedLength: number }}
 */
function scanPublishedProtocols(text, opts = {}) {
  const { cutoff = -1 } = opts;
  if (!text || typeof text !== 'string') {
    return { matches: [], scannedLength: 0 };
  }

  const scanText = cutoff >= 0 ? text.slice(0, cutoff) : text;

  // Keyed on the normalized identifier so "https://doi.org/10.3791/61234" and
  // "10.3791/61234" in the same manuscript collapse to one match.
  const byNormalized = new Map();

  for (const { type, re } of CANDIDATE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scanText)) !== null) {
      const identifier = trimIdentifier(m[0]);
      if (!identifier) continue;

      const source = inferSourceFromIdentifier(identifier);
      if (!source || !isProtocolVenueSource(source)) continue;

      const key = normalizeRawValue(identifier);
      if (!key || byNormalized.has(key)) continue;

      byNormalized.set(key, { identifier, source, type, position: m.index });
    }
  }

  return {
    matches: [...byNormalized.values()].sort((a, b) => a.position - b.position),
    scannedLength: scanText.length
  };
}

module.exports = {
  scanPublishedProtocols,
  // exposed for tests
  trimIdentifier
};
