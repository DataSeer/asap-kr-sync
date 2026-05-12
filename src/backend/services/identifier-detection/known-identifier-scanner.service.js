/**
 * Known-identifier scanner.
 *
 * Sweeps text (markdown converted from a PDF) for identifiers we already know
 * about (built into an index by known-identifier-index.service.js) and emits
 * one match per known entry hit.
 *
 * Match flow per identifier type:
 *
 *   - structured types (RRID, SCR, DOI, URL, PID-like accessions):
 *       regex sweep → normalize → lookup in index.byIdentifier.
 *
 *   - catalog numbers:
 *       three passes ordered by precision. Each pass only emits if the entry
 *       hasn't been matched at a higher precision yet (so the rubric below
 *       composes cleanly):
 *         (a) vendor proximity AND `Cat#`/`Cat. no.`-style prefix nearby ⇒ HIGH
 *         (b) vendor proximity OR prefix nearby                          ⇒ MEDIUM
 *         (c) bare match (catalog token on its own)                      ⇒ LOW
 *
 * Output (per match):
 *   {
 *     entry,          // EnrichmentListEntry snapshot from the index
 *     position,       // char offset of the first hit in the ORIGINAL text
 *     relevance,      // 'HIGH' | 'MEDIUM' | 'LOW'
 *     types,          // string[] — every identifier type that matched
 *     identifiers,    // [{ type, value, position }]
 *     catalogContext  // optional: { vendorNearby, prefixNearby } for catalog hits
 *   }
 *
 * Pure function — no DB, no async, no I/O.
 */

const {
  normalizeRawValue
} = require('../pdf-analysis/identifier-normalize.service');

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
const REFERENCES_HEADING_RE = /^[ \t]*#+\s*(?:References?|Bibliography|Citations|Works\s+Cited|Literature\s+Cited)\b.*$/im;

const STRUCTURED_PATTERNS = [
  { type: 'doi',  re: /\b10\.\d{4,9}\/[^\s,;)\]]+/gi,                     normalize: v => normalizeRawValue(v) },
  { type: 'rrid', re: /\bRRID:\s*([A-Za-z]+_[A-Za-z0-9]+)/gi,            normalize: (_v, m) => normalizeRawValue(m[1]) },
  { type: 'scr',  re: /\bSCR_\d+\b/gi,                                   normalize: v => normalizeRawValue(v) },
  { type: 'url',  re: /https?:\/\/[^\s,;)\]<>"]+/gi,                     normalize: v => normalizeRawValue(v) }
];

const PID_SCAN_PATTERNS = [
  /\b(?:GSE|GSM|GPL|GDS)\d+\b/gi,
  /\b(?:SRR|SRX|SRP|SRA)\d+\b/gi,
  /\bPRJ[A-Z]{2,3}\d+\b/gi,
  /\bSAM[A-Z]{1,2}\d+\b/gi,
  /\bE-[A-Z]{4}-\d+\b/gi,
  /\bphs\d+(?:\.v\d+(?:\.p\d+)?)?\b/gi,
  /\bHRA\d{6}\b/gi,
  /\bTAIR\d+\b/gi,
  /\bPXD\d+\b/gi,            // ProteomeXchange
  /\bMSV\d{6,}\b/gi          // MassIVE
];

// "Cat#", "Cat. no.", "Catalog Number", "Product No.", optional separators
const CAT_PREFIX_RE = /\b(?:Cat(?:alog(?:ue)?)?\.?\s*(?:#|No\.?|Number)?|Product\s*(?:#|No\.?|Number))\s*[:#]?\s*/gi;

// Catalog candidate token: alphanumeric body (with -, _, .) bounded on both
// sides. Length 4–32 keeps "p<0.05"-style noise out and matches typical
// vendor SKUs (HY-102007, sc-32233, AB12345, N0502-At488-L, etc.).
const CATALOG_TOKEN_RE = /\b[A-Za-z0-9][A-Za-z0-9_\-.]{2,30}[A-Za-z0-9]\b/g;

const RELEVANCE_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

function relevanceRank(r) { return RELEVANCE_RANK[r] || 0; }

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Match aggregator: one entry → one match (highest relevance wins).
// ---------------------------------------------------------------------------
function makeAggregator() {
  const byEntryId = new Map();

  function add(entry, type, value, position, relevance, extra = {}) {
    if (!entry || !entry.id) return;
    let m = byEntryId.get(entry.id);
    if (!m) {
      m = {
        entry,
        position,
        relevance,
        types: new Set(),
        identifiers: [],
        catalogContext: null
      };
      byEntryId.set(entry.id, m);
    }
    m.types.add(type);
    m.identifiers.push({ type, value, position });
    if (relevanceRank(relevance) > relevanceRank(m.relevance)) {
      m.relevance = relevance;
      m.position = position; // position of the strongest hit
    }
    if (extra.catalogContext) {
      // Merge catalog context flags (OR them).
      m.catalogContext = {
        vendorNearby: !!(m.catalogContext?.vendorNearby || extra.catalogContext.vendorNearby),
        prefixNearby: !!(m.catalogContext?.prefixNearby || extra.catalogContext.prefixNearby)
      };
    }
  }

  function values() {
    return [...byEntryId.values()].map(m => ({
      ...m,
      types: [...m.types]
    }));
  }

  function hasEntry(entryId) { return byEntryId.has(entryId); }

  return { add, values, hasEntry };
}

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------
function findReferencesCutoff(text) {
  const m = text.match(REFERENCES_HEADING_RE);
  return m ? m.index : -1;
}

function sweepStructured(text, index, agg) {
  // Sweep generic types (DOI/RRID/SCR/URL) using STRUCTURED_PATTERNS.
  for (const { type, re, normalize } of STRUCTURED_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const normalized = normalize(raw, m).toLowerCase();
      if (!normalized) continue;
      const hit = index.byIdentifier.get(`${type}::${normalized}`);
      if (hit) agg.add(hit.entry, type, raw, m.index, 'HIGH');
      // Some entries store DOIs as `doi::...` while the URL form
      // 'https://doi.org/<doi>' was indexed as 'url::doi.org/<doi>'.
      // The normalizeRawValue routine strips 'doi.org/' prefixes for DOI
      // tokens but leaves URL-form keys intact, so a URL-shaped hit may also
      // resolve to a DOI in the index. Try both directions.
      if (type === 'url' && normalized.startsWith('doi.org/')) {
        const doiNorm = normalized.slice('doi.org/'.length);
        const doiHit = index.byIdentifier.get(`doi::${doiNorm}`);
        if (doiHit) agg.add(doiHit.entry, 'doi', raw, m.index, 'HIGH');
      }
    }
  }

  // Sweep PID-like accession formats. These are typed as `pid` in the index.
  for (const re of PID_SCAN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const normalized = raw.toLowerCase();
      const hit = index.byIdentifier.get(`pid::${normalized}`);
      if (hit) agg.add(hit.entry, 'pid', raw, m.index, 'HIGH');
    }
  }
}

/**
 * Locate all occurrences of every known vendor name (case-insensitive) in the
 * text. Returns a sorted array of `{ vendor, pos }` for windowed lookups.
 */
function buildVendorPositions(text, index) {
  const seenVendors = new Set();
  for (const { vendor } of index.byCatalog.values()) {
    if (vendor && vendor.length >= 3) seenVendors.add(vendor);
  }
  for (const list of index.catalogTokens.values()) {
    for (const { vendor } of list) {
      if (vendor && vendor.length >= 3) seenVendors.add(vendor);
    }
  }

  const positions = [];
  for (const vendor of seenVendors) {
    const re = new RegExp(escapeRegex(vendor), 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      positions.push({ vendor, pos: m.index });
    }
  }
  positions.sort((a, b) => a.pos - b.pos);
  return positions;
}

function buildPrefixPositions(text) {
  const positions = [];
  CAT_PREFIX_RE.lastIndex = 0;
  let m;
  while ((m = CAT_PREFIX_RE.exec(text)) !== null) {
    positions.push(m.index + m[0].length); // end-of-prefix offset
  }
  return positions;
}

function vendorMatchesNear(catalogPos, expectedVendor, vendorPositions, window) {
  if (!expectedVendor) return false;
  for (const { vendor, pos } of vendorPositions) {
    if (vendor !== expectedVendor) continue;
    if (Math.abs(pos - catalogPos) <= window) return true;
    if (pos > catalogPos + window) break; // sorted — early exit
  }
  return false;
}

function anyVendorNear(catalogPos, vendorPositions, window) {
  for (const { pos } of vendorPositions) {
    if (Math.abs(pos - catalogPos) <= window) return true;
    if (pos > catalogPos + window) break;
  }
  return false;
}

function prefixNear(catalogPos, prefixPositions, window) {
  for (const pos of prefixPositions) {
    // A prefix is "nearby" iff its end falls within `window` chars BEFORE
    // the catalog token (prefixes always precede the SKU).
    const distance = catalogPos - pos;
    if (distance >= 0 && distance <= window) return true;
    if (pos > catalogPos) break;
  }
  return false;
}

/**
 * Scan for catalog tokens. Three passes; each pass only adds to the
 * aggregator if the entry isn't already there at a higher relevance.
 */
function sweepCatalogs(text, index, agg, opts) {
  const { proximityWindow, prefixWindow, includeBareLow, minCatalogLength } = opts;
  const vendorPositions = buildVendorPositions(text, index);
  const prefixPositions = buildPrefixPositions(text);

  CATALOG_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = CATALOG_TOKEN_RE.exec(text)) !== null) {
    const raw = m[0];
    if (raw.length < minCatalogLength) continue;
    const normalized = raw.toLowerCase().replace(/\s+/g, '');
    const candidates = index.catalogTokens.get(normalized);
    if (!candidates || candidates.length === 0) continue;

    const pos = m.index;
    const hasPrefix = prefixNear(pos, prefixPositions, prefixWindow);

    for (const { entry, vendor } of candidates) {
      const expectedVendorPresent = vendor
        ? vendorMatchesNear(pos, vendor, vendorPositions, proximityWindow)
        : false;
      const anyVendorPresent = anyVendorNear(pos, vendorPositions, proximityWindow);

      let relevance = null;
      if (expectedVendorPresent && hasPrefix) relevance = 'HIGH';
      else if (expectedVendorPresent) relevance = 'MEDIUM';
      else if (hasPrefix) relevance = 'MEDIUM';
      else if (includeBareLow) relevance = 'LOW';

      if (!relevance) continue;
      // Suppress LOW if this looks like a generic alphanumeric token AND no
      // vendor at all is in the document — that's the highest false-positive
      // case. We allow LOW only if at least SOMETHING vendor-ish is in the
      // doc, which is a weak but useful heuristic.
      if (relevance === 'LOW' && vendorPositions.length === 0 && !hasPrefix) continue;

      agg.add(entry, 'catalog', raw, pos, relevance, {
        catalogContext: {
          vendorNearby: expectedVendorPresent || anyVendorPresent,
          prefixNearby: hasPrefix
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Scan a body of text against the prebuilt identifier index.
 *
 * @param {string} text
 * @param {ReturnType<typeof import('./known-identifier-index.service').buildIndex>} index
 * @param {object} [opts]
 * @param {boolean} [opts.cutAtReferences=true]   Truncate at references heading
 * @param {number}  [opts.proximityWindow=200]    Vendor-near-catalog radius (chars)
 * @param {number}  [opts.prefixWindow=30]        Cat#-before-catalog radius (chars)
 * @param {boolean} [opts.includeBareLow=true]    Emit LOW-relevance bare catalog hits
 * @param {number}  [opts.minCatalogLength=4]     Skip catalog tokens shorter than this
 * @returns {{ matches: Array, referencesCutoff: number, scannedLength: number }}
 */
function scan(text, index, opts = {}) {
  const {
    cutAtReferences = true,
    proximityWindow = 200,
    prefixWindow = 30,
    includeBareLow = true,
    minCatalogLength = 4
  } = opts;

  if (!text || typeof text !== 'string' || !index) {
    return { matches: [], referencesCutoff: -1, scannedLength: 0 };
  }

  let scanText = text;
  let cutoff = -1;
  if (cutAtReferences) {
    cutoff = findReferencesCutoff(text);
    if (cutoff >= 0) scanText = text.slice(0, cutoff);
  }

  const agg = makeAggregator();
  sweepStructured(scanText, index, agg);
  sweepCatalogs(scanText, index, agg, {
    proximityWindow, prefixWindow, includeBareLow, minCatalogLength
  });

  return {
    matches: agg.values(),
    referencesCutoff: cutoff,
    scannedLength: scanText.length
  };
}

module.exports = {
  scan,
  // exposed for tests
  findReferencesCutoff,
  buildVendorPositions,
  buildPrefixPositions
};
