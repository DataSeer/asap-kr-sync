/**
 * Enrichment List Controller
 * CRUD operations for the consolidated enrichment reference list.
 * Handles all 4 categories: software, materials, datasets, protocols.
 * Category is always scoped via req.params.category (set by route middleware).
 * Uses standardized KRT column fields.
 */

const { EnrichmentListEntry, sequelize } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { escapeCsvField, stripCsvFormulaGuard } = require('../utils/csv');

const CSV_HEADERS = ['resourceType', 'resourceName', 'source', 'identifier', 'newReuse', 'additionalInformation', 'suggestedEntity', 'tokens'];

const VALID_CATEGORIES = ['software', 'materials', 'datasets', 'protocols'];

// Mirrors VARCHAR limits in EnrichmentListEntry model. TEXT columns (source,
// identifier, additionalInformation) and JSONB (tokens) are omitted — Postgres
// won't truncate those. Keep in sync with src/backend/models/EnrichmentListEntry.js.
const IMPORT_FIELD_LIMITS = {
  resourceType: 100,
  resourceName: 1000,
  newReuse: 10,
  suggestedEntity: 500
};
const VALID_NEW_REUSE = new Set(['new', 'reuse']);

/**
 * Invalidate the detection cache for a category. A failed invalidation must
 * not fail the write that triggered it, but it means stale detection results
 * until the next refresh — so it is logged, never swallowed.
 */
function invalidateCacheSafe(category) {
  try {
    const enrichmentListService = require('../services/enrichment-list.service');
    enrichmentListService.invalidateCache(category);
  } catch (error) {
    logger.warn('Enrichment list cache invalidation failed — detection may serve stale entries', {
      category,
      error: error.message
    });
  }
}

/**
 * List entries for a category with optional search and resource type filter.
 */
async function list(req, res, next) {
  try {
    const { category } = req.params;
    const { search, resourceType, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const where = { category };
    if (resourceType) {
      where.resourceType = resourceType;
    }
    if (search) {
      where[Op.or] = [
        { resourceName: { [Op.iLike]: `%${search}%` } },
        { identifier: { [Op.iLike]: `%${search}%` } }
      ];
    }

    const { count, rows } = await EnrichmentListEntry.findAndCountAll({
      where,
      order: [['resource_name', 'ASC']],
      limit: Math.min(parseInt(limit), 100),
      offset: parseInt(offset)
    });

    res.json({
      entries: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Cross-category list. Drives the unified Enrichments admin UI.
 *
 *   GET /api/enrichment-list?category=software&search=&page=1&limit=50
 *
 * `category` is optional — when omitted, entries from every category are
 * returned in one paginated stream. Same search/sort/pagination semantics as
 * `list`. Each row keeps its `category` field so the UI can group/colour-code.
 */
async function listAll(req, res, next) {
  try {
    const { search, category, resourceType, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({
          error: `Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`
        });
      }
      where.category = category;
    }
    if (resourceType) where.resourceType = resourceType;
    if (search) {
      where[Op.or] = [
        { resourceName: { [Op.iLike]: `%${search}%` } },
        { identifier: { [Op.iLike]: `%${search}%` } }
      ];
    }

    const { count, rows } = await EnrichmentListEntry.findAndCountAll({
      where,
      order: [['category', 'ASC'], ['resource_name', 'ASC']],
      limit: Math.min(parseInt(limit), 100),
      offset: parseInt(offset)
    });

    res.json({
      entries: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Cross-category counts. One round-trip for every tab badge in the UI:
 *
 *   GET /api/enrichment-list/_counts
 *   → { software: 11465, materials: 19382, datasets: 22688, protocols: 6859, total: 60394 }
 */
async function getAllCounts(req, res, next) {
  try {
    const counts = await EnrichmentListEntry.findAll({
      attributes: [
        'category',
        [EnrichmentListEntry.sequelize.fn('COUNT', '*'), 'count']
      ],
      group: ['category'],
      raw: true
    });

    const result = { software: 0, materials: 0, datasets: 0, protocols: 0, total: 0 };
    for (const row of counts) {
      const c = parseInt(row.count);
      if (row.category in result) result[row.category] = c;
      result.total += c;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Get entry counts per resource type for a category.
 */
async function getCounts(req, res, next) {
  try {
    const { category } = req.params;

    const counts = await EnrichmentListEntry.findAll({
      attributes: [
        'resourceType',
        [EnrichmentListEntry.sequelize.fn('COUNT', '*'), 'count']
      ],
      where: { category },
      group: ['resourceType'],
      raw: true
    });

    const result = {};
    let total = 0;
    for (const row of counts) {
      const c = parseInt(row.count);
      result[row.resourceType || row.resource_type] = c;
      total += c;
    }
    result.total = total;

    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Get a single entry by ID (still validates it belongs to the correct category).
 */
async function getById(req, res, next) {
  try {
    const { category } = req.params;
    const entry = await EnrichmentListEntry.findOne({
      where: { id: req.params.entryId, category }
    });
    if (!entry) {
      return res.status(404).json({ error: 'Enrichment list entry not found' });
    }
    res.json(entry);
  } catch (error) {
    next(error);
  }
}

/**
 * Create a new entry. Category is always taken from the route param, not the request body.
 */
async function create(req, res, next) {
  try {
    const { category } = req.params;
    const { resourceType, resourceName, source, identifier, newReuse, additionalInformation, suggestedEntity, tokens } = req.validatedBody;

    const entry = await EnrichmentListEntry.create({
      category,
      resourceType,
      resourceName,
      source: source || null,
      identifier: identifier || null,
      newReuse: newReuse || null,
      additionalInformation: additionalInformation || null,
      suggestedEntity: suggestedEntity || null,
      tokens: tokens || []
    });

    logger.info('Enrichment list entry created', { id: entry.id, category, resourceType, resourceName: entry.resourceName });
    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
}

/**
 * Update an entry.
 */
async function update(req, res, next) {
  try {
    const { category } = req.params;
    const entry = await EnrichmentListEntry.findOne({
      where: { id: req.params.entryId, category }
    });
    if (!entry) {
      return res.status(404).json({ error: 'Enrichment list entry not found' });
    }

    const { resourceType, resourceName, source, identifier, newReuse, additionalInformation, suggestedEntity, tokens } = req.validatedBody;

    if (resourceType !== undefined) entry.resourceType = resourceType;
    if (resourceName !== undefined) entry.resourceName = resourceName;
    if (source !== undefined) entry.source = source || null;
    if (identifier !== undefined) entry.identifier = identifier || null;
    if (newReuse !== undefined) entry.newReuse = newReuse || null;
    if (additionalInformation !== undefined) entry.additionalInformation = additionalInformation || null;
    if (suggestedEntity !== undefined) entry.suggestedEntity = suggestedEntity || null;
    if (tokens !== undefined) entry.tokens = tokens;

    await entry.save();

    invalidateCacheSafe(category);

    logger.info('Enrichment list entry updated', { id: entry.id, category, resourceName: entry.resourceName });
    res.json(entry);
  } catch (error) {
    next(error);
  }
}

/**
 * Delete an entry.
 */
async function remove(req, res, next) {
  try {
    const { category } = req.params;
    const entry = await EnrichmentListEntry.findOne({
      where: { id: req.params.entryId, category }
    });
    if (!entry) {
      return res.status(404).json({ error: 'Enrichment list entry not found' });
    }

    await entry.destroy();

    invalidateCacheSafe(category);

    logger.info('Enrichment list entry deleted', { id: entry.id, category, resourceName: entry.resourceName });
    res.json({ message: 'Entry deleted' });
  } catch (error) {
    next(error);
  }
}

/**
 * Bulk import entries from parsed CSV data.
 * Expects { entries: [{ resourceType, resourceName, ... }], mode: 'append' | 'replace', resourceType? }
 *
 * When mode='replace' and a resourceType is provided, only entries matching that
 * category+resourceType are deleted (scoped replace). When mode='replace' without
 * a resourceType, all entries for the category are deleted.
 */
async function importEntries(req, res, next) {
  try {
    const { category } = req.params;
    const { entries, mode, resourceType: defaultType } = req.validatedBody;

    const invalid = entries.filter(e => !e.resourceName || !e.resourceName.trim());
    if (invalid.length > 0) {
      return res.status(400).json({ error: `${invalid.length} entries are missing a resource name` });
    }

    // Per-row field-length and enum validation. We do this here (not in the Joi
    // import schema, which is intentionally permissive on inner entries) so that
    // a single bad row gets a row-pointed 400 instead of a generic Postgres 22001
    // mid-bulkCreate. Limits must match the model's VARCHAR definitions.
    const violations = [];
    const MAX_REPORTED = 20;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // When defaultType is set, the controller overrides per-row resourceType, so
      // validate the effective value rather than the raw one.
      const effective = { ...e, resourceType: defaultType || e.resourceType };
      for (const [field, max] of Object.entries(IMPORT_FIELD_LIMITS)) {
        const v = effective[field];
        if (typeof v === 'string' && v.length > max) {
          violations.push({ row: i + 1, field, length: v.length, max });
          if (violations.length >= MAX_REPORTED) break;
        }
      }
      if (e.newReuse != null && e.newReuse !== '' && !VALID_NEW_REUSE.has(String(e.newReuse).toLowerCase())) {
        violations.push({ row: i + 1, field: 'newReuse', value: e.newReuse, expected: "'new' or 'reuse'" });
      }
      if (violations.length >= MAX_REPORTED) break;
    }
    if (violations.length > 0) {
      return res.status(400).json({
        error: 'Some rows have field values that exceed column limits or use invalid enums. Fix them in the CSV and retry.',
        violations
      });
    }

    // Postgres rejects NUL bytes (\u0000) in TEXT and JSONB (SQLSTATE 22P05).
    // Some source CSVs contain stray NULs from upstream encoding issues; strip them
    // from every string we hand to the DB. Also remove the formula guard our own
    // CSV export prefixes onto dangerous cells, so export -> re-import round-trips.
    const stripNul = (v) => (typeof v === 'string' ? stripCsvFormulaGuard(v.replace(/\u0000/g, '')) : v);

    const records = entries.map(e => ({
      category,
      resourceType: stripNul(defaultType || e.resourceType),
      resourceName: stripNul(e.resourceName).trim(),
      source: stripNul(e.source) || null,
      identifier: stripNul(e.identifier) || null,
      newReuse: stripNul(e.newReuse) || null,
      additionalInformation: stripNul(e.additionalInformation) || null,
      suggestedEntity: stripNul(e.suggestedEntity) || null,
      tokens: Array.isArray(e.tokens) ? e.tokens.map(stripNul) : []
    })).filter(e => e.resourceType);

    if (records.length === 0) {
      return res.status(400).json({ error: 'No valid entries (check resourceType field)' });
    }

    // Replace mode deletes the existing (curated, potentially tens of thousands
    // of rows) list before inserting — the two steps must commit or roll back
    // together, otherwise a failed bulkCreate leaves the category empty.
    const { deletedCount, created } = await sequelize.transaction(async (t) => {
      let deleted = 0;
      if (mode === 'replace' && defaultType) {
        // Scoped replace: only delete entries for this category + resourceType
        deleted = await EnrichmentListEntry.destroy({ where: { category, resourceType: defaultType }, transaction: t });
      } else if (mode === 'replace') {
        // Full replace: delete all entries for this category
        deleted = await EnrichmentListEntry.destroy({ where: { category }, transaction: t });
      }

      const rows = await EnrichmentListEntry.bulkCreate(records, { transaction: t });
      return { deletedCount: deleted, created: rows };
    });

    invalidateCacheSafe(category);

    logger.info('Enrichment list bulk import', { category, mode, importedCount: created.length, deletedCount });

    res.status(201).json({
      imported: created.length,
      mode,
      ...(mode === 'replace' ? { previouslyDeleted: deletedCount } : {})
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Export entries as CSV. Optional ?resourceType= filter.
 * Filename includes the category name.
 */
async function exportCsv(req, res, next) {
  try {
    const { category } = req.params;
    const { resourceType } = req.query;

    const where = { category };
    if (resourceType) where.resourceType = resourceType;

    const entries = await EnrichmentListEntry.findAll({
      where,
      order: [['resource_type', 'ASC'], ['resource_name', 'ASC']],
      raw: true
    });

    const csvRows = [CSV_HEADERS.join(',')];
    for (const e of entries) {
      // `raw: true` returns rows keyed by the model's camelCase attribute names
      // (resourceType, newReuse, …), NOT the snake_case DB columns — reading
      // snake_case here silently exported those five fields blank, so the file
      // couldn't be re-imported (every row was dropped for lacking a name/type).
      csvRows.push([
        escapeCsvField(e.resourceType),
        escapeCsvField(e.resourceName),
        escapeCsvField(e.source),
        escapeCsvField(e.identifier),
        escapeCsvField(e.newReuse),
        escapeCsvField(e.additionalInformation),
        escapeCsvField(e.suggestedEntity),
        escapeCsvField(JSON.stringify(e.tokens || []))
      ].join(','));
    }

    const filename = resourceType
      ? `${category}-${resourceType}.csv`
      : `${category}-list.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvRows.join('\n'));
  } catch (error) {
    next(error);
  }
}

module.exports = { list, listAll, getCounts, getAllCounts, getById, create, update, remove, importEntries, exportCsv };
