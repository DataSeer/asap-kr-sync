/**
 * Known-identifier index.
 *
 * Builds two in-memory lookup maps from EnrichmentListEntry rows:
 *
 *   1. byIdentifier — keyed on `${type}::${normalizedValue}`.
 *      Type is one of the structured identifier types produced by
 *      identifier-normalize.service.js (rrid, doi, scr, pid, url, …).
 *      Used for direct lookups when the scanner finds a structured
 *      identifier in PDF text.
 *
 *   2. byCatalog — keyed on `${vendorLc}::${catalogLc}` for entries whose
 *      identifier doesn't extract as a structured type (the typical "catalog
 *      number" case). Vendor comes from EnrichmentListEntry.source so two
 *      vendors using the same catalog token don't collide.
 *
 *   3. catalogTokens — Set of normalized catalog tokens (no vendor) used when
 *      scanning text for catalog-only matches (option-b: with `Cat#` prefix
 *      but no expected vendor nearby; or bare LOW-relevance matches).
 *
 * Each map value is the same shape: `{ entry, type, normalized, vendor }`
 * where `entry` is a snapshot of the EnrichmentListEntry row.
 *
 * The index is pure data — no DB, no I/O — so it can be built from any
 * iterable of entries. `loadIndex()` wraps the DB read with a cache.
 */

const {
  extractIdentifierTokens,
  normalizeRawValue
} = require('../pdf-analysis/identifier-normalize.service');
const { dbProvider } = require('../enrichment-list-providers');
const logger = require('../../utils/logger');

/** PID/accession formats we treat as structured. The token type stored on the
 *  index is `pid` regardless of which family it came from — the regex sweep
 *  side uses the same type when looking up. */
const PID_PATTERNS = [
  /^(GSE|GSM|GPL|GDS)\d+$/i,                       // GEO
  /^(SRR|SRX|SRP|SRA)\d+$/i,                       // SRA
  /^(PRJ[A-Z]{2,3})\d+$/i,                         // BioProject
  /^(SAM[A-Z]{1,2})\d+$/i,                         // BioSample
  /^E-[A-Z]{4}-\d+$/i,                             // ArrayExpress
  /^phs\d+(\.v\d+(\.p\d+)?)?$/i,                   // dbGaP
  /^HRA\d{6}$/i,                                   // GSA HRA
  /^TAIR\d+$/i,
  /^PXD\d+$/i,                                     // ProteomeXchange
  /^MSV\d{6,}$/i,                                  // MassIVE
  /^[A-Z]{1,2}\d{5,8}(\.\d+)?$/i                   // GenBank-like (broad fallback)
];

function isPidLike(s) {
  if (!s) return false;
  return PID_PATTERNS.some(re => re.test(s));
}

function normalizeVendor(vendor) {
  if (!vendor) return '';
  return String(vendor).toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeCatalog(catalog) {
  if (!catalog) return '';
  // Catalog tokens are case-insensitive in practice; collapse separators.
  return String(catalog).toLowerCase().trim().replace(/\s+/g, '');
}

/**
 * Whether a normalized string is plausibly a catalog/SKU token. The source
 * CSV is dirty enough that bare English words like "exception" or "shared"
 * occasionally end up in the identifier column; if we accepted those as
 * catalog tokens, every occurrence of the corresponding word in any PDF would
 * trigger a false-positive match.
 *
 * Real catalogs almost always contain at least one digit (HY-102007, A8592,
 * sc-32233, ab1791, N0502-At488-L, …). Pure-alphabetic catalogs are vanishingly
 * rare in practice, so we drop them.
 */
function looksLikeCatalog(normalized) {
  if (!normalized) return false;
  if (normalized.length < 3 || normalized.length > 40) return false;
  if (!/\d/.test(normalized)) return false;     // must contain at least one digit

  // Pure-digit tokens are risky: a 4-digit year is the most common false-
  // positive (1990s, 2000s, 2019 …). Allow only ≥5 digits so we keep
  // legit numeric SKUs (e.g. Sigma "300027") while rejecting years.
  if (/^\d+$/.test(normalized)) {
    return normalized.length >= 5;
  }
  return true;
}

/**
 * Snapshot the fields we care about from an EnrichmentListEntry row.
 * Keeps the index decoupled from Sequelize instance shape.
 */
function entrySnapshot(entry) {
  return {
    id: entry.id,
    category: entry.category,
    resourceType: entry.resourceType || entry.resource_type || '',
    resourceName: entry.resourceName || entry.resource_name || '',
    source: entry.source || '',
    identifier: entry.identifier || '',
    newReuse: entry.newReuse || entry.new_reuse || '',
    suggestedEntity: entry.suggestedEntity || entry.suggested_entity || '',
    additionalInformation: entry.additionalInformation || entry.additional_information || ''
  };
}

/**
 * Build the index from a list of entries (pure function — no I/O).
 *
 * @param {Array<object>} entries - EnrichmentListEntry-shaped rows
 * @returns {{
 *   byIdentifier: Map<string, {entry, type, normalized, vendor}>,
 *   byCatalog: Map<string, {entry, type, normalized, vendor}>,
 *   catalogTokens: Map<string, Array<{entry, vendor}>>,
 *   stats: object
 * }}
 */
function buildIndex(entries) {
  const byIdentifier = new Map();
  const byCatalog = new Map();
  const catalogTokens = new Map(); // normalized catalog → list of {entry,vendor}
  const stats = {
    total: 0,
    indexedAsIdentifier: 0,
    indexedAsCatalogWithVendor: 0,
    indexedAsCatalogNoVendor: 0,
    skipped: 0,
    byType: {} // type → count
  };

  for (const raw of entries || []) {
    stats.total++;
    const entry = entrySnapshot(raw);
    const idField = entry.identifier;
    if (!idField) { stats.skipped++; continue; }

    // 1. Try to extract typed tokens (rrid, doi, url, scr, pmid, …).
    const tokens = extractIdentifierTokens(idField);
    let placed = false;

    for (const tok of tokens) {
      const colon = tok.indexOf(':');
      if (colon < 0) continue;
      const type = tok.slice(0, colon);
      const value = tok.slice(colon + 1);
      // 'catalog' tokens from the extractor are too noisy alone — handle them
      // via the byCatalog path below where vendor context disambiguates.
      if (type === 'catalog') continue;
      const key = `${type}::${value}`;
      if (!byIdentifier.has(key)) {
        byIdentifier.set(key, { entry, type, normalized: value, vendor: entry.source });
        stats.byType[type] = (stats.byType[type] || 0) + 1;
      }
      placed = true;
    }

    // 2. Detect bare PID-like accessions that the extractor couldn't type.
    if (!placed) {
      const opaque = normalizeRawValue(idField);
      if (isPidLike(opaque) || isPidLike(idField.trim())) {
        const value = opaque.toLowerCase();
        const key = `pid::${value}`;
        if (!byIdentifier.has(key)) {
          byIdentifier.set(key, { entry, type: 'pid', normalized: value, vendor: entry.source });
          stats.byType.pid = (stats.byType.pid || 0) + 1;
        }
        placed = true;
      }
    }

    if (placed) { stats.indexedAsIdentifier++; continue; }

    // 3. Fallback: treat as catalog. Vendor proximity / Cat# prefix decide
    //    relevance at scan time; here we just register the token.
    const catalogNorm = normalizeCatalog(idField);
    if (!catalogNorm || !looksLikeCatalog(catalogNorm)) { stats.skipped++; continue; }

    const vendor = normalizeVendor(entry.source);
    if (vendor) {
      const key = `${vendor}::${catalogNorm}`;
      if (!byCatalog.has(key)) {
        byCatalog.set(key, { entry, type: 'catalog', normalized: catalogNorm, vendor });
        stats.indexedAsCatalogWithVendor++;
      }
    } else {
      stats.indexedAsCatalogNoVendor++;
    }

    // Always register the bare token so the prefix-only and bare-LOW scans
    // can find it; multiple entries can share the token, so this is a list.
    if (!catalogTokens.has(catalogNorm)) catalogTokens.set(catalogNorm, []);
    catalogTokens.get(catalogNorm).push({ entry, vendor });
  }

  return { byIdentifier, byCatalog, catalogTokens, stats };
}

/** Cache keyed by provider.name so we can switch sources in-process. */
const _caches = new Map();

/**
 * Load enrichment entries through the given provider and build the index.
 * Result is cached per-provider until invalidateCache() is called.
 *
 * @param {object} [options]
 * @param {object} [options.provider] - Defaults to the DB provider.
 * @returns {Promise<ReturnType<typeof buildIndex>>}
 */
async function loadIndex({ provider = dbProvider } = {}) {
  if (_caches.has(provider.name)) return _caches.get(provider.name);

  let index;
  try {
    const entries = await provider.loadEntries();
    index = buildIndex(entries);
    logger.info('Known-identifier index built', {
      provider: provider.name,
      total: index.stats.total,
      indexedAsIdentifier: index.stats.indexedAsIdentifier,
      indexedAsCatalogWithVendor: index.stats.indexedAsCatalogWithVendor,
      indexedAsCatalogNoVendor: index.stats.indexedAsCatalogNoVendor,
      skipped: index.stats.skipped,
      byType: index.stats.byType
    });
  } catch (err) {
    logger.warn('Failed to build known-identifier index', {
      provider: provider.name, error: err.message
    });
    index = buildIndex([]);
  }
  _caches.set(provider.name, index);
  return index;
}

function invalidateCache() {
  _caches.clear();
}

module.exports = {
  buildIndex,
  loadIndex,
  invalidateCache,
  // exposed for tests
  normalizeVendor,
  normalizeCatalog,
  looksLikeCatalog,
  isPidLike
};
