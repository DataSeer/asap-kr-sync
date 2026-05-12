/**
 * Config Service
 * Provides cached access to configuration stored in database
 */

const { Team, ResourceType, AppConfig } = require('../models');
const logger = require('../utils/logger');

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;

// In-memory cache with per-key timestamps
const cache = {
  teams: { data: null, refreshedAt: null },
  resourceTypes: { data: null, refreshedAt: null },
  resourceTypeGroupOrder: { data: null, refreshedAt: null },
  validationRules: { data: null, refreshedAt: null }
};

/**
 * Check if a specific cache entry is valid
 * @param {object} entry - Cache entry with data and refreshedAt
 */
function isEntryValid(entry) {
  return entry.refreshedAt && (Date.now() - entry.refreshedAt) < CACHE_TTL;
}

/**
 * Get all active team codes from database (cached)
 * @returns {Promise<string[]>}
 */
async function getTeams() {
  if (isEntryValid(cache.teams) && cache.teams.data !== null) {
    return cache.teams.data;
  }

  const codes = await Team.getActiveCodes();
  cache.teams = { data: codes, refreshedAt: Date.now() };
  return codes;
}

/**
 * Get all active resource type names from database (cached)
 * @returns {Promise<string[]>}
 */
async function getResourceTypes() {
  if (isEntryValid(cache.resourceTypes) && cache.resourceTypes.data !== null) {
    return cache.resourceTypes.data;
  }

  const names = await ResourceType.getActiveNames();
  cache.resourceTypes = { data: names, refreshedAt: Date.now() };
  return names;
}

/**
 * Get resource type group order mapping from database (cached).
 * Maps resource type name → sort group number (0=dataset, 1=software, 2=protocol, 3=lab_material).
 * @returns {Promise<object>} e.g., { "Dataset": 0, "Code/Software": 1, "Antibody": 3, ... }
 */
async function getResourceTypeGroupOrder() {
  if (isEntryValid(cache.resourceTypeGroupOrder) && cache.resourceTypeGroupOrder.data !== null) {
    return cache.resourceTypeGroupOrder.data;
  }

  const typeOrder = { dataset: 0, software: 1, protocol: 2, lab_material: 3 };
  const items = await ResourceType.getActiveWithType();
  const mapping = {};
  for (const item of items) {
    mapping[item.name] = typeOrder[item.type] ?? 3;
  }
  cache.resourceTypeGroupOrder = { data: mapping, refreshedAt: Date.now() };
  return mapping;
}

/**
 * Get validation rules from database (cached)
 * @returns {Promise<object>}
 */
async function getValidationRules() {
  if (isEntryValid(cache.validationRules) && cache.validationRules.data !== null) {
    return cache.validationRules.data;
  }

  const rules = await AppConfig.getValue('validation_rules');
  cache.validationRules = { data: rules || {}, refreshedAt: Date.now() };
  return cache.validationRules.data;
}

/**
 * Invalidate the cache (call when config changes)
 */
function invalidateCache() {
  cache.teams = { data: null, refreshedAt: null };
  cache.resourceTypes = { data: null, refreshedAt: null };
  cache.resourceTypeGroupOrder = { data: null, refreshedAt: null };
  cache.validationRules = { data: null, refreshedAt: null };
  logger.debug('Config cache invalidated');
}

/**
 * Initialize the config service
 * Pre-loads all config into cache at startup
 */
async function initialize() {
  try {
    // Pre-load all config into cache
    await Promise.all([
      getTeams(),
      getResourceTypes(),
      getValidationRules()
    ]);
    logger.info('Config service initialized', {
      teamsCount: cache.teams.data?.length || 0,
      resourceTypesCount: cache.resourceTypes.data?.length || 0,
      hasValidationRules: !!cache.validationRules.data
    });
  } catch (error) {
    logger.error('Failed to initialize config service', { error: error.message });
    throw error;
  }
}

module.exports = {
  getTeams,
  getResourceTypes,
  getResourceTypeGroupOrder,
  getValidationRules,
  invalidateCache,
  initialize
};
