/**
 * Teams Controller
 */

const { Team, UserTeam, Submission } = require('../models');
const { NotFoundError, ConflictError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const { ROLES } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * List all teams
 * GET /api/teams
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { active } = req.query;

    const whereClause = {};
    if (active !== undefined) {
      whereClause.active = active === 'true';
    }

    const { count, rows } = await Team.findAndCountAll({
      where: whereClause,
      order: [['code', 'ASC']],
      limit,
      offset
    });

    res.json({
      teams: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all active team codes (for dropdowns/validation)
 * GET /api/teams/codes
 */
async function getCodes(req, res, next) {
  try {
    const codes = await Team.getActiveCodes();
    res.json({ codes });
  } catch (error) {
    next(error);
  }
}

/**
 * Get team by ID
 * GET /api/teams/:id
 */
async function getById(req, res, next) {
  try {
    const team = await Team.findByPk(req.params.id);

    if (!team) {
      throw new NotFoundError('Team');
    }

    // Count users in this team
    const userCount = await UserTeam.count({ where: { team: team.code } });

    res.json({
      team: {
        ...team.toJSON(),
        userCount
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create team
 * POST /api/teams
 */
async function create(req, res, next) {
  try {
    const { code, name } = req.validatedBody;

    // Check if code already exists (Joi already trimmed + uppercased + pattern-checked)
    const existing = await Team.findOne({ where: { code } });
    if (existing) {
      throw new ConflictError('Team code already exists');
    }

    const team = await Team.create({
      code,
      name: name || null,
      active: true
    });

    logger.info('Team created', { teamId: team.id, code: team.code, createdBy: req.userId });

    res.status(201).json({ team });
  } catch (error) {
    next(error);
  }
}

/**
 * Update team
 * PATCH /api/teams/:id
 */
async function update(req, res, next) {
  try {
    const team = await Team.findByPk(req.params.id);
    if (!team) {
      throw new NotFoundError('Team');
    }

    const { code, name, active } = req.validatedBody;

    // If code is being changed, check for conflicts (Joi already uppercased)
    if (code && code !== team.code) {
      const existing = await Team.findOne({ where: { code } });
      if (existing) {
        throw new ConflictError('Team code already exists');
      }

      // Update user_teams references with the new code
      const oldCode = team.code;
      await UserTeam.update(
        { team: code },
        { where: { team: oldCode } }
      );

      team.code = code;
    }

    if (name !== undefined) team.name = name || null;
    if (active !== undefined) team.active = active;

    await team.save();

    logger.info('Team updated', { teamId: team.id, code: team.code, updatedBy: req.userId });

    res.json({ team });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete team
 * DELETE /api/teams/:id
 */
async function deleteTeam(req, res, next) {
  try {
    const team = await Team.findByPk(req.params.id);
    if (!team) {
      throw new NotFoundError('Team');
    }

    // Check if team has users assigned
    const userCount = await UserTeam.count({ where: { team: team.code } });
    if (userCount > 0) {
      return res.status(400).json({
        error: `Cannot delete team with ${userCount} assigned user(s). Remove users first or deactivate the team.`
      });
    }

    // ds_annotator cannot delete a team that still has submissions attached;
    // admins can force-delete.
    if (req.user.role !== ROLES.ADMIN) {
      const submissionCount = await Submission.count({ where: { team: team.code } });
      if (submissionCount > 0) {
        return res.status(400).json({
          error: `Cannot delete team with ${submissionCount} attached submission(s). Reassign them first or ask an admin.`
        });
      }
    }

    await team.destroy();

    logger.info('Team deleted', { teamId: team.id, code: team.code, deletedBy: req.userId });

    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getCodes,
  getById,
  create,
  update,
  delete: deleteTeam
};
