/**
 * Enrichment List Service
 *
 * Loads the consolidated enrichment reference list and provides:
 *   - loadList(category, { provider }):    load entries for a category (cached per provider)
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
 * Invalidate the cached list for a specific category across ALL providers.
 * @param {string} category
 */
function invalidateCache(category) {
  if (!VALID_CATEGORIES.includes(category)) return;
  for (const key of [..._caches.keys()]) {
    if (key.endsWith(`::${category}`)) _caches.delete(key);
  }
}

module.exports = { loadList, invalidateCache };
