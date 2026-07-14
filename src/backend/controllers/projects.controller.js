/**
 * Projects Controller
 * Manage the ASAP projects (2-letter grant codes) used to label/validate a
 * submission's `project` and to power the dashboard's project filter.
 */

const { Project, Submission } = require('../models');
const { NotFoundError, ConflictError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const { invalidateConfigCache: invalidateCache } = require('../config/constants');
const { escapeCsvField, stripCsvFormulaGuard } = require('../utils/csv');
const logger = require('../utils/logger');

const CSV_HEADERS = ['code', 'piName', 'title', 'active'];
const CODE_RE = /^[A-Z0-9]{2}$/;

/** Parse a CSV "active" cell into a boolean (blank → true, the common default). */
function parseActive(v) {
  if (v == null || String(v).trim() === '') return true;
  return ['true', '1', 'yes', 'y', 'active'].includes(String(v).trim().toLowerCase());
}

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

/**
 * Export all projects as CSV (code, piName, title, active). The file
 * re-imports cleanly via importCsv.
 * GET /api/projects/export
 */
async function exportCsv(req, res, next) {
  try {
    // `raw: true` returns rows keyed by the camelCase attribute names
    // (piName), NOT the snake_case DB columns — read those keys.
    const projects = await Project.findAll({ order: [['code', 'ASC']], raw: true });
    const rows = [CSV_HEADERS.join(',')];
    for (const p of projects) {
      rows.push([
        escapeCsvField(p.code),
        escapeCsvField(p.piName),
        escapeCsvField(p.title),
        escapeCsvField(p.active ? 'true' : 'false')
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="projects.csv"');
    res.send(rows.join('\n'));
  } catch (error) {
    next(error);
  }
}

/**
 * Import (upsert) projects from parsed CSV rows. Each row is matched by `code`:
 * an existing project is updated, a new code is created. Invalid codes are
 * skipped and reported.
 * POST /api/projects/import  { projects: [{ code, piName, title, active }] }
 */
async function importCsv(req, res, next) {
  try {
    const { projects } = req.validatedBody;
    let created = 0;
    let updated = 0;
    const invalid = [];

    for (const row of projects) {
      const code = String(row.code || '').trim().toUpperCase();
      if (!CODE_RE.test(code)) {
        invalid.push(row.code || '(blank)');
        continue;
      }
      const clean = (v) => {
        const s = v == null ? '' : stripCsvFormulaGuard(String(v)).trim();
        return s || null;
      };
      const piName = clean(row.piName != null ? row.piName : row.pi_name);
      const title = clean(row.title);
      const active = parseActive(row.active);

      const existing = await Project.findByPk(code);
      if (existing) {
        existing.piName = piName;
        existing.title = title;
        existing.active = active;
        await existing.save();
        updated++;
      } else {
        await Project.create({ code, piName, title, active });
        created++;
      }
    }

    if (created + updated === 0) {
      return res.status(400).json({
        error: 'No valid projects to import — the code must be exactly 2 letters/digits.',
        invalid
      });
    }

    invalidateCache();
    logger.info('Projects imported', { created, updated, invalid: invalid.length, importedBy: req.userId });

    res.status(201).json({ created, updated, invalid });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getCodes,
  create,
  update,
  delete: deleteProject,
  exportCsv,
  importCsv
};
