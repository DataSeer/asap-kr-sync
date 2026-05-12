/**
 * App Config Controller
 */

const { AppConfig } = require('../models');
const { NotFoundError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const { invalidateConfigCache } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * List all configs
 * GET /api/app-config
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { category } = req.query;

    const whereClause = {};
    if (category) {
      whereClause.category = category;
    }

    const { count, rows } = await AppConfig.findAndCountAll({
      where: whereClause,
      order: [['category', 'ASC'], ['key', 'ASC']],
      limit,
      offset
    });

    res.json({
      configs: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get config by key
 * GET /api/app-config/:key
 */
async function getByKey(req, res, next) {
  try {
    const config = await AppConfig.findOne({ where: { key: req.params.key } });

    if (!config) {
      throw new NotFoundError('Config');
    }

    res.json({ config });
  } catch (error) {
    next(error);
  }
}

/**
 * Create or update config
 * PUT /api/app-config
 */
async function upsert(req, res, next) {
  try {
    const { key, value, description, category } = req.validatedBody;

    const config = await AppConfig.setValue(key, value, {
      description,
      category
    });

    // Invalidate cache
    invalidateConfigCache();

    logger.info('Config upserted', {
      configId: config.id,
      key: config.key,
      updatedBy: req.userId
    });

    res.json({ config });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete config
 * DELETE /api/app-config/:key
 */
async function deleteConfig(req, res, next) {
  try {
    const config = await AppConfig.findOne({ where: { key: req.params.key } });

    if (!config) {
      throw new NotFoundError('Config');
    }

    await config.destroy();

    // Invalidate cache
    invalidateConfigCache();

    logger.info('Config deleted', {
      configId: config.id,
      key: config.key,
      deletedBy: req.userId
    });

    res.json({ message: 'Config deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getByKey,
  upsert,
  delete: deleteConfig
};
