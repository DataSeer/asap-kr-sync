/**
 * Enrichment List Service
 *
 * Loads the consolidated enrichment reference list and provides:
 *   - loadList(category, { provider }):    load entries for a category (cached per provider)
 *   - enrichMentions(category, mentions, { provider }):
 *                                          cross-reference mentions with list metadata
 *   - invalidateCache(category):           clear the cache for a category (all providers)
 *
 * The reference data comes from a pluggable `provider` (see
 * `enrichment-list-providers.js`). The default is the DB-backed provider
 * (production); the CSV-backed provider is used by benchmarks and tests so
 * they can drive enrichment without DB access. Caching is per-(provider,
 * category) so switching providers in the same process doesn't return stale
 * data.
 */

const logger = require('../utils/logger');
const { dbProvider, VALID_CATEGORIES } = require('./enrichment-list-providers');

/** Cache keyed by `${provider.name}::${category}`. */
const _caches = new Map();

function cacheKey(providerName, category) {
  return `${providerName}::${category}`;
}

/**
 * Load enrichment list entries for a given category (cached per provider).
 * @param {string} category - One of 'software', 'materials', 'datasets', 'protocols'
 * @param {object} [options]
 * @param {object} [options.provider] - Defaults to the DB provider.
 * @returns {Promise<Array<object>>}
 */
async function loadList(category, { provider = dbProvider } = {}) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid enrichment list category: ${category}`);
  }

  const key = cacheKey(provider.name, category);
  if (_caches.has(key)) return _caches.get(key);

  try {
    const entries = await provider.loadEntries(category);
    _caches.set(key, entries);
    logger.info('Enrichment list loaded', {
      provider: provider.name, category, entries: entries.length
    });
  } catch (err) {
    logger.warn('Failed to load enrichment list', {
      provider: provider.name, category, error: err.message
    });
    _caches.set(key, []);
  }

  return _caches.get(key);
}

/**
 * Detection mentions use a few different field-name conventions:
 *  - Softcite (software): { name, normalizedName, url, ... }
 *  - Gemini (datasets/materials/protocols): { canonical_name, resource_type,
 *    source, identifier, newReuse, ... }
 *  - Direct KRT-shape: { resourceName, resourceType, ... }
 *
 * `STANDARD_FIELDS` lists the KRT-shaped target fields the enrichment list can
 * fill in. Each entry maps the canonical key to the alternate names that might
 * already exist on the mention.
 */
const STANDARD_FIELDS = {
  source: ['source'],
  identifier: ['identifier'],
  newReuse: ['newReuse', 'new_reuse']
};

function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Enrich detected mentions with metadata from the enrichment list.
 *
 * For each mention:
 *  1. Find a matching entry (resourceName / normalizedName / suggestedEntity / tokens).
 *  2. If matched, fill in any missing KRT-shaped fields (source, identifier,
 *     newReuse) from the enrichment entry. Existing values on the mention always
 *     win — enrichment never overwrites detector output.
 *  3. Attach `customListMatch` (the raw match) and `enrichmentMeta` (which
 *     fields were filled from the list) so downstream consumers can show
 *     provenance in the UI.
 *
 * @param {string} category - One of 'software', 'materials', 'datasets', 'protocols'
 * @param {Array<object>} mentions
 * @param {object} [options]
 * @param {object} [options.provider] - Defaults to the DB provider.
 * @returns {Promise<{ enriched: Array<object>, durationMs: number }>}
 */
async function enrichMentions(category, mentions, { provider = dbProvider } = {}) {
  const start = Date.now();
  const list = await loadList(category, { provider });

  const enriched = mentions.map(mention => {
    // Support multiple field names: 'name' (softcite), 'canonical_name' (gemini), 'resourceName'
    const rawName = mention.name || mention.canonical_name || mention.resourceName || '';
    if (!rawName) {
      return { ...mention, customListMatch: null, enrichmentMeta: { matched: false, filledFields: [] } };
    }
    const nameLC = rawName.toLowerCase().trim();
    const normalizedLC = (mention.normalizedName || '').toLowerCase().trim();

    // Try exact match first (resourceName or suggestedEntity)
    let match = list.find(e =>
      e.resourceName.toLowerCase() === nameLC
      || e.resourceName.toLowerCase() === normalizedLC
      || (e.suggestedEntity && e.suggestedEntity.toLowerCase() === nameLC)
    );

    // Fallback: check if any token set matches
    if (!match) {
      match = list.find(e => {
        if (!e.tokens || e.tokens.length === 0) return false;
        const tokenStr = e.tokens.join(' ').toLowerCase();
        return tokenStr === nameLC || nameLC.includes(tokenStr);
      });
    }

    if (!match) {
      return { ...mention, customListMatch: null, enrichmentMeta: { matched: false, filledFields: [] } };
    }

    // Fill missing standard fields from the enrichment entry. The mention's
    // existing values always win — enrichment is gap-filling, not overwrite.
    const merged = { ...mention };
    const filledFields = [];
    for (const [targetKey, aliases] of Object.entries(STANDARD_FIELDS)) {
      const existing = aliases.map(a => merged[a]).find(v => !isMissing(v));
      if (isMissing(existing) && !isMissing(match[targetKey])) {
        merged[targetKey] = match[targetKey];
        filledFields.push(targetKey);
      }
    }

    return {
      ...merged,
      customListMatch: {
        resourceName: match.resourceName,
        source: match.source,
        identifier: match.identifier,
        newReuse: match.newReuse,
        suggestedEntity: match.suggestedEntity
      },
      enrichmentMeta: { matched: true, filledFields }
    };
  });

  const durationMs = Date.now() - start;
  return { enriched, durationMs };
}

/**
 * Invalidate the cached list for a specific category across ALL providers.
 * @param {string} category
 */
function invalidateCache(category) {
  if (!VALID_CATEGORIES.includes(category)) return;
  for (const key of [..._caches.keys()]) {
    if (key.endsWith(`::${category}`)) _caches.delete(key);
  }
}

module.exports = { loadList, enrichMentions, invalidateCache };
