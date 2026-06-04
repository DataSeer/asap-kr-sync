/**
 * Enrichment list providers
 *
 * The identifier-scan index (`loadIndex`) reads curated reference data to build
 * its scan index. In production that data lives in the `EnrichmentListEntry`
 * table; in benchmarks and tests we need to drive the same code from local CSVs
 * without DB access.
 *
 * A "provider" is a small object with one method:
 *   `loadEntries(category?: string)` → Promise<EnrichmentEntry[]>
 *
 * If `category` is omitted, the provider returns entries for ALL categories
 * (the identifier-scan index needs the full set). Each entry returned MUST
 * carry a `category` field so downstream consumers can filter.
 *
 * Provider entries are shaped like EnrichmentListEntry rows:
 *   { id, category, resourceType, resourceName, source, identifier,
 *     newReuse, suggestedEntity, additionalInformation, tokens }
 */

const fs = require('fs');
const path = require('path');

const VALID_CATEGORIES = ['software', 'materials', 'datasets', 'protocols'];

// ─────────────────────────────────────────────────────────────────────────────
// DB provider — wraps the EnrichmentListEntry model. Default in production.
// ─────────────────────────────────────────────────────────────────────────────

const dbProvider = {
  name: 'db',
  async loadEntries(category) {
    // Lazy-require to avoid pulling Sequelize in CSV-only callers (benchmarks).
    const { EnrichmentListEntry } = require('../models');
    const where = category ? { category } : {};
    const rows = await EnrichmentListEntry.findAll({ where, raw: true });
    return rows.map(e => ({
      id: e.id,
      category: e.category,
      resourceType: e.resourceType || e.resource_type || '',
      resourceName: e.resourceName || e.resource_name || '',
      source: e.source || '',
      identifier: e.identifier || '',
      newReuse: e.newReuse || e.new_reuse || '',
      suggestedEntity: e.suggestedEntity || e.suggested_entity || '',
      additionalInformation: e.additionalInformation || e.additional_information || '',
      tokens: e.tokens || []
    }));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CSV provider — reads tmp/identifiers/curated-<category>.csv. Used by the
// benchmark/snapshot scripts so they can drive enrichment without DB access.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal RFC 4180 reader. Inlined so this module has zero dependencies —
 * it's loaded by the benchmark script which already does the same.
 */
function parseCSV(content, onRecord) {
  let field = '', record = [], state = 'FIELD_START', i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (state === 'FIELD_START') {
      if (c === '"') { state = 'IN_QUOTED'; i++; continue; }
      if (c === ',') { record.push(field); field = ''; i++; continue; }
      if (c === '\n') { record.push(field); onRecord(record); record = []; field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      state = 'IN_UNQUOTED'; continue;
    }
    if (state === 'IN_UNQUOTED') {
      if (c === ',') { record.push(field); field = ''; state = 'FIELD_START'; i++; continue; }
      if (c === '\n') { record.push(field); onRecord(record); record = []; field = ''; state = 'FIELD_START'; i++; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++; continue;
    }
    if (state === 'IN_QUOTED') {
      if (c === '"') { state = 'AFTER_QUOTE'; i++; continue; }
      field += c; i++; continue;
    }
    if (state === 'AFTER_QUOTE') {
      if (c === '"') { field += '"'; state = 'IN_QUOTED'; i++; continue; }
      if (c === ',') { record.push(field); field = ''; state = 'FIELD_START'; i++; continue; }
      if (c === '\n') { record.push(field); onRecord(record); record = []; field = ''; state = 'FIELD_START'; i++; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field !== '' || record.length > 0) { record.push(field); onRecord(record); }
}

function readCategoryCsv(csvDir, category) {
  const csvPath = path.join(csvDir, `curated-${category}.csv`);
  if (!fs.existsSync(csvPath)) return [];
  const content = fs.readFileSync(csvPath, 'utf-8');
  const entries = [];
  let header = null, colIdx = null;
  parseCSV(content, (rec) => {
    if (!header) {
      header = rec;
      colIdx = Object.fromEntries(rec.map((h, i) => [h, i]));
      return;
    }
    const get = (k) => (colIdx[k] != null ? rec[colIdx[k]] : '') || '';
    const identifier = get('identifier');
    if (!identifier) return;
    entries.push({
      id: `${category}::${entries.length}`,
      category,
      resourceType: get('resourceType') || category,
      resourceName: get('resourceName') || '',
      source: get('source') || '',
      identifier,
      newReuse: get('newReuse') || '',
      suggestedEntity: get('suggestedEntity') || '',
      additionalInformation: get('additionalInformation') || '',
      tokens: []
    });
  });
  return entries;
}

/**
 * Build a CSV-backed provider rooted at the given directory.
 * @param {string} csvDir  Directory containing `curated-<category>.csv` files.
 */
function createCsvProvider(csvDir) {
  if (!csvDir || typeof csvDir !== 'string') {
    throw new Error('createCsvProvider requires a directory path');
  }
  return {
    name: `csv:${csvDir}`,
    async loadEntries(category) {
      const cats = category ? [category] : VALID_CATEGORIES;
      const all = [];
      for (const cat of cats) {
        all.push(...readCategoryCsv(csvDir, cat));
      }
      return all;
    }
  };
}

module.exports = {
  VALID_CATEGORIES,
  dbProvider,
  createCsvProvider
};
