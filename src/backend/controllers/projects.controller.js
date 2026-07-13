/**
 * Projects Controller
 * Manage the ASAP projects (2-letter grant codes) used to label/validate a
 * submission's `project` and to power the dashboard's project filter.
 */

const { Project, Submission } = require('../models');
const { NotFoundError, ConflictError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const { invalidateConfigCache: invalidateCache } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * List projects
 * GET /api/projects
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { active } = req.query;

    const whereClause = {};
    if (active !== undefined) {
      whereClause.active = active === 'true';
    }

    const { count, rows } = await Project.findAndCountAll({
      where: whereClause,
      order: [['code', 'ASC']],
      limit,
      offset
    });

    res.json({
      projects: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all active project codes (for dropdowns / validation)
 * GET /api/projects/codes
 */
async function getCodes(req, res, next) {
  try {
    const codes = await Project.getActiveCodes();
    res.json({ codes });
  } catch (error) {
    next(error);
  }
}

/**
 * Create project
 * POST /api/projects
 */
async function create(req, res, next) {
  try {
    const { code, piName, title, active } = req.validatedBody;

    const existing = await Project.findByPk(code);
    if (existing) {
      throw new ConflictError('Project code already exists');
    }

    const project = await Project.create({
      code,
      piName: piName || null,
      title: title || null,
      active: active === undefined ? true : active
    });

    invalidateCache();
    logger.info('Project created', { code: project.code, createdBy: req.userId });

    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
}

/**
 * Update project (code is the immutable key — only metadata/active change).
 * PATCH /api/projects/:code
 */
async function update(req, res, next) {
  try {
    const project = await Project.findByPk(req.params.code);
    if (!project) {
      throw new NotFoundError('Project');
    }

    const { piName, title, active } = req.validatedBody;
    if (piName !== undefined) project.piName = piName || null;
    if (title !== undefined) project.title = title || null;
    if (active !== undefined) project.active = active;

    await project.save();

    invalidateCache();
    logger.info('Project updated', { code: project.code, updatedBy: req.userId });

    res.json({ project });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete project
 * DELETE /api/projects/:code
 */
async function deleteProject(req, res, next) {
  try {
    const project = await Project.findByPk(req.params.code);
    if (!project) {
      throw new NotFoundError('Project');
    }

    // Submissions store the project code as a plain value (no FK), so a delete
    // won't orphan rows — but warn if the code is still in use, as deleting it
    // removes the PI/title reference for a grant that has submissions.
    const submissionCount = await Submission.count({ where: { project: project.code } });
    if (submissionCount > 0) {
      return res.status(400).json({
        error: `Cannot delete project with ${submissionCount} submission(s). Deactivate it instead.`
      });
    }

    await project.destroy();

    invalidateCache();
    logger.info('Project deleted', { code: project.code, deletedBy: req.userId });

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getCodes,
  create,
  update,
  delete: deleteProject
};
