/**
 * Resource Types Controller
 */

const { ResourceType, sequelize } = require('../models');
const { NotFoundError, ConflictError, ValidationError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const { invalidateConfigCache } = require('../config/constants');
const logger = require('../utils/logger');
const { escapeCsvField, stripCsvFormulaGuard } = require('../utils/csv');

/**
 * List all resource types
 * GET /api/resource-types
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { active } = req.query;

    const whereClause = {};
    if (active !== undefined) {
      whereClause.active = active === 'true';
    }

    const { count, rows } = await ResourceType.findAndCountAll({
      where: whereClause,
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
      limit,
      offset
    });

    res.json({
      resourceTypes: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all active resource type names (for dropdowns)
 * GET /api/resource-types/names
 */
async function getNames(req, res, next) {
  try {
    const items = await ResourceType.getActiveWithType();
    // Return both names (for backward compat) and items with type info
    res.json({
      names: items.map(i => i.name),
      items
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get resource type by ID
 * GET /api/resource-types/:id
 */
async function getById(req, res, next) {
  try {
    const resourceType = await ResourceType.findByPk(req.params.id);

    if (!resourceType) {
      throw new NotFoundError('Resource type');
    }

    res.json({ resourceType });
  } catch (error) {
    next(error);
  }
}

/**
 * Create resource type
 * POST /api/resource-types
 */
async function create(req, res, next) {
  try {
    const { name, description, active, sortOrder, type } = req.body;

    if (!name || name.trim() === '') {
      throw new ValidationError('Resource type name is required');
    }

    // Check if name already exists
    const existing = await ResourceType.findOne({ where: { name: name.trim() } });
    if (existing) {
      throw new ConflictError('Resource type name already exists');
    }

    const resourceType = await ResourceType.create({
      name: name.trim(),
      description: description || null,
      active: active !== false,
      type: type || 'lab_material',
      sortOrder: sortOrder || 0
    });

    // Invalidate cache
    invalidateConfigCache();

    logger.info('Resource type created', {
      resourceTypeId: resourceType.id,
      name: resourceType.name,
      createdBy: req.userId
    });

    res.status(201).json({ resourceType });
  } catch (error) {
    next(error);
  }
}

/**
 * Update resource type
 * PATCH /api/resource-types/:id
 */
async function update(req, res, next) {
  try {
    const resourceType = await ResourceType.findByPk(req.params.id);
    if (!resourceType) {
      throw new NotFoundError('Resource type');
    }

    const { name, description, active, sortOrder, type } = req.body;

    // If name is being changed, check for conflicts
    if (name && name.trim() !== resourceType.name) {
      const existing = await ResourceType.findOne({ where: { name: name.trim() } });
      if (existing) {
        throw new ConflictError('Resource type name already exists');
      }
      resourceType.name = name.trim();
    }

    if (description !== undefined) resourceType.description = description || null;
    if (active !== undefined) resourceType.active = active;
    if (type !== undefined) resourceType.type = type;
    if (sortOrder !== undefined) resourceType.sortOrder = sortOrder;

    await resourceType.save();

    // Invalidate cache
    invalidateConfigCache();

    logger.info('Resource type updated', {
      resourceTypeId: resourceType.id,
      name: resourceType.name,
      updatedBy: req.userId
    });

    res.json({ resourceType });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete resource type
 * DELETE /api/resource-types/:id
 */
async function deleteResourceType(req, res, next) {
  try {
    const resourceType = await ResourceType.findByPk(req.params.id);
    if (!resourceType) {
      throw new NotFoundError('Resource type');
    }

    await resourceType.destroy();

    // Invalidate cache
    invalidateConfigCache();

    logger.info('Resource type deleted', {
      resourceTypeId: resourceType.id,
      name: resourceType.name,
      deletedBy: req.userId
    });

    res.json({ message: 'Resource type deleted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Export all resource types as CSV
 * GET /api/resource-types/export
 */
async function exportCsv(req, res, next) {
  try {
    const entries = await ResourceType.findAll({
      order: [['sortOrder', 'ASC'], ['name', 'ASC']],
      raw: true
    });

    const headers = ['name', 'type', 'description', 'sortOrder', 'active'];
    const csvRows = [headers.join(',')];

    for (const e of entries) {
      const row = [
        escapeCsvField(e.name),
        escapeCsvField(e.type || 'lab_material'),
        escapeCsvField(e.description),
        e.sort_order ?? 0,
        e.active ? 'true' : 'false'
      ];
      csvRows.push(row.join(','));
    }

    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="resource-types.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
}

/**
 * Bulk import resource types from parsed CSV data.
 * POST /api/resource-types/import
 * Expects { entries: [{ name, description?, sortOrder?, active? }], mode: 'append' | 'replace' }
 */
async function importEntries(req, res, next) {
  try {
    const { entries, mode = 'append' } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError('No entries provided');
    }

    const invalid = entries.filter(e => !e.name || !e.name.trim());
    if (invalid.length > 0) {
      throw new ValidationError(`${invalid.length} entries are missing a name`);
    }

    // stripCsvFormulaGuard reverses the formula-injection prefix our own CSV
    // export adds, so export -> re-import round-trips values unchanged.
    const records = entries.map((e, i) => ({
      name: stripCsvFormulaGuard(e.name.trim()),
      type: e.type || 'lab_material',
      description: stripCsvFormulaGuard(e.description) || null,
      sortOrder: e.sortOrder ?? i,
      active: e.active !== false && e.active !== 'false'
    }));

    // Replace mode truncates the whole table before inserting — the two steps
    // must commit or roll back together, or a failed bulkCreate leaves the
    // resource-type list empty.
    const { deletedCount, created } = await sequelize.transaction(async (t) => {
      let deleted = 0;
      if (mode === 'replace') {
        deleted = await ResourceType.destroy({ where: {}, truncate: true, transaction: t });
      }
      const rows = await ResourceType.bulkCreate(records, { transaction: t });
      return { deletedCount: deleted, created: rows };
    });

    // Invalidate cache
    invalidateConfigCache();

    logger.info('Resource types bulk import', {
      mode,
      importedCount: created.length,
      deletedCount,
      importedBy: req.userId
    });

    res.status(201).json({
      imported: created.length,
      mode,
      ...(mode === 'replace' ? { previouslyDeleted: deletedCount } : {})
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getNames,
  getById,
  create,
  update,
  delete: deleteResourceType,
  exportCsv,
  importEntries
};
