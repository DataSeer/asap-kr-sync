/**
 * Users Controller
 */

const { Op } = require('sequelize');
const { User, UserTeam } = require('../models');
const { NotFoundError, ConflictError, AuthorizationError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const { ROLES } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * Only admins may create or modify admin-role users. Prevents a ds_annotator
 * from promoting themselves or another account to admin, or from editing an
 * existing admin's profile.
 */
function assertCanTouchAdminRole(actor, targetRole) {
  if (targetRole === ROLES.ADMIN && actor.role !== ROLES.ADMIN) {
    throw new AuthorizationError('Only admins can manage admin users');
  }
}

/**
 * List all users
 * GET /api/users
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);

    let whereClause = {};

    // ASAP PM can only see users belonging to their teams (or users with no teams if PM has no teams)
    if (req.user.role === ROLES.ASAP_PM) {
      const userTeams = req.user.teams || [];

      if (userTeams.length === 0) {
        // PM has no teams - can only see users who also have no teams
        const usersWithTeams = await UserTeam.findAll({
          attributes: ['userId'],
          group: ['userId']
        });
        const userIdsWithTeams = usersWithTeams.map(ut => ut.userId);

        // Filter for users NOT in the list of users with teams (i.e., users without teams)
        if (userIdsWithTeams.length > 0) {
          whereClause = { id: { [Op.notIn]: userIdsWithTeams } };
        }
        // If no users have teams, whereClause stays empty (show all)
      } else {
        // Find users who have any of these teams
        const usersInTeams = await UserTeam.findAll({
          where: { team: { [Op.in]: userTeams } },
          attributes: ['userId'],
          group: ['userId']
        });
        const userIds = usersInTeams.map(ut => ut.userId);

        if (userIds.length === 0) {
          return res.json({
            users: [],
            pagination: buildPaginationMeta(0, page, limit)
          });
        }

        whereClause = { id: { [Op.in]: userIds } };
      }
    }

    const { count, rows } = await User.findAndCountAll({
      where: whereClause,
      attributes: ['id', 'email', 'name', 'role', 'createdAt'],
      include: [{
        model: UserTeam,
        as: 'userTeams',
        attributes: ['team']
      }],
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    // Transform to include teams array
    const users = rows.map(user => {
      const userData = user.toJSON();
      userData.teams = userData.userTeams ? userData.userTeams.map(ut => ut.team) : [];
      delete userData.userTeams;
      return userData;
    });

    res.json({
      users,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get user by ID
 * GET /api/users/:id
 */
async function getById(req, res, next) {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: ['id', 'email', 'name', 'role', 'createdAt', 'updatedAt'],
      include: [{
        model: UserTeam,
        as: 'userTeams',
        attributes: ['team']
      }]
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    // Transform to include teams array
    const userData = user.toJSON();
    userData.teams = userData.userTeams ? userData.userTeams.map(ut => ut.team) : [];
    delete userData.userTeams;

    res.json({ user: userData });
  } catch (error) {
    next(error);
  }
}

/**
 * Create user
 * POST /api/users
 */
async function create(req, res, next) {
  try {
    const { email, password, name, role, teams } = req.validatedBody;

    // Only admins can create admin users
    assertCanTouchAdminRole(req.user, role);

    // Check if email already exists
    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) {
      throw new ConflictError('Email already registered');
    }

    const user = await User.create({
      email,
      passwordHash: password,
      name,
      role
    });

    // Create team associations
    if (teams && teams.length > 0) {
      await UserTeam.bulkCreate(
        teams.map(team => ({ userId: user.id, team }))
      );
    }

    logger.info('User created by admin', { userId: user.id, email: user.email, createdBy: req.userId });

    // Fetch user with teams
    const userData = user.toJSON();
    userData.teams = teams || [];

    res.status(201).json({ user: userData });
  } catch (error) {
    next(error);
  }
}

/**
 * Update user
 * PATCH /api/users/:id
 */
async function update(req, res, next) {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      throw new NotFoundError('User');
    }

    const { name, role, teams, password } = req.validatedBody;

    // Block ds_annotator (or anyone non-admin) from modifying an existing admin
    // or from promoting any user to admin.
    assertCanTouchAdminRole(req.user, user.role);
    if (role) {
      assertCanTouchAdminRole(req.user, role);
    }

    if (name) user.name = name;
    if (role) user.role = role;
    if (password) user.passwordHash = password;

    await user.save();

    // Update team associations if provided
    if (teams !== undefined) {
      // Remove existing team associations
      await UserTeam.destroy({ where: { userId: user.id } });
      // Create new team associations
      if (teams.length > 0) {
        await UserTeam.bulkCreate(
          teams.map(team => ({ userId: user.id, team }))
        );
      }
    }

    logger.info('User updated by admin', { userId: user.id, updatedBy: req.userId });

    // Fetch updated teams
    const userTeams = await UserTeam.findAll({
      where: { userId: user.id },
      attributes: ['team']
    });
    const userData = user.toJSON();
    userData.teams = userTeams.map(ut => ut.team);

    res.json({ user: userData });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete user
 * DELETE /api/users/:id
 */
async function deleteUser(req, res, next) {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      throw new NotFoundError('User');
    }

    // Prevent self-deletion
    if (user.id === req.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await user.destroy();

    logger.info('User deleted by admin', { deletedUserId: user.id, deletedBy: req.userId });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getById,
  create,
  update,
  delete: deleteUser
};
