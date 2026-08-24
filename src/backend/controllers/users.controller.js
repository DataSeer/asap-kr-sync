/**
 * Users Controller
 */

const crypto = require('crypto');
const { Op } = require('sequelize');
const { User, UserTeam, RefreshToken, sequelize } = require('../models');
const { NotFoundError, ConflictError, AuthorizationError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const teamEmailService = require('../services/teams/team-email.service');
const authService = require('../services/auth/auth.service');
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
 * Only an admin may set another user's password.
 *
 * `password` is optional on this endpoint, so the check is on the field being
 * present rather than on the route — a ds_annotator editing a name must still
 * succeed. Users change their own password through /profile, which requires
 * the current one.
 *
 * @param {object} actor - the authenticated user making the request
 * @param {string} [password] - the password from the validated body, if any
 */
function assertCanSetPassword(actor, password) {
  if (password && actor.role !== ROLES.ADMIN) {
    throw new AuthorizationError('Only admins can change another user\'s password');
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

    // Anonymised accounts are tombstones kept for referential integrity — they
    // hold no identity to manage, so they are not listed. `deleted` cannot
    // collide with anything whereClause sets above (`id`).
    const { count, rows } = await User.findAndCountAll({
      where: { ...whereClause, deleted: false },
      // `auth0Sub` is needed so toJSON() can compute the `isAuth0User` flag.
      // The toJSON method strips the raw value before serialization — only
      // the boolean leaves the server.
      attributes: ['id', 'email', 'name', 'role', 'createdAt', 'auth0Sub'],
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
    const user = await User.findOne({
      where: { id: req.params.id, deleted: false },
      attributes: ['id', 'email', 'name', 'role', 'createdAt', 'updatedAt', 'auth0Sub'],
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

    // Mirror the team-scoping that `list` enforces: an ASAP PM may only read
    // users who share one of their teams (or teamless users if the PM has no
    // teams). Without this a PM could enumerate any user by ID, bypassing the
    // list scope. 404 (not 403) so we don't confirm the target's existence.
    if (req.user.role === ROLES.ASAP_PM) {
      const pmTeams = req.user.teams || [];
      const targetTeams = userData.teams || [];
      const shareTeam = pmTeams.length === 0
        ? targetTeams.length === 0
        : targetTeams.some(team => pmTeams.includes(team));
      if (!shareTeam) {
        throw new NotFoundError('User');
      }
    }

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

    // User + team associations commit together — a failed bulkCreate must not
    // leave a user without their assigned teams.
    const user = await sequelize.transaction(async (t) => {
      const created = await User.create({
        email,
        passwordHash: password,
        name,
        role
      }, { transaction: t });

      if (teams && teams.length > 0) {
        await UserTeam.bulkCreate(
          teams.map(team => ({ userId: created.id, team })),
          { transaction: t }
        );
      }

      return created;
    });

    logger.info('User created by admin', { userId: user.id, email: user.email, createdBy: req.userId });

    // Merge in the (team, email) roster on top of the explicitly assigned
    // teams, same as the login flows do.
    const mappedTeams = await teamEmailService.applyMappingsForUser(user.id, user.email);

    const userData = user.toJSON();
    userData.teams = [...new Set([...(teams || []), ...mappedTeams])];

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
    // An anonymised account has no identity left to edit, and re-granting it a
    // role or a password would resurrect it — 404, as for any other unknown id.
    const user = await User.findOne({ where: { id: req.params.id, deleted: false } });
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

    // Setting someone else's password is admin-only. Whoever sets it knows it,
    // and can then sign in as that person — so this is account takeover, not a
    // lesser form of editing. Every other field here is recoverable; this one
    // hands over the account. Note it is NOT the same as creating a user with
    // an initial password, which starts an account rather than seizing one.
    assertCanSetPassword(req.user, password);

    if (name) user.name = name;
    if (role) user.role = role;
    if (password) user.passwordHash = password;

    // Profile fields and team associations commit together — the old
    // destroy-then-bulkCreate sequence could strip a user of every team if
    // the re-insert failed.
    await sequelize.transaction(async (t) => {
      await user.save({ transaction: t });

      // Update team associations if provided
      if (teams !== undefined) {
        await UserTeam.destroy({ where: { userId: user.id }, transaction: t });
        if (teams.length > 0) {
          await UserTeam.bulkCreate(
            teams.map(team => ({ userId: user.id, team })),
            { transaction: t }
          );
        }
      }
    });

    // An admin resetting someone's password ends that person's sessions — ALL
    // of them, with no exception: the admin is not the one holding them, and
    // the usual reason for an admin reset is that the account may be
    // compromised. Leaving a live session behind would defeat the reset.
    if (password) {
      const revoked = await authService.revokeAllForUser(user.id, 'password_changed');
      logger.info('Admin reset a password — sessions signed out', {
        userId: user.id, resetBy: req.userId, revoked
      });
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
 * Delete a user — by anonymising the account, never by removing the row.
 *
 * `DELETE FROM users` cascades. `submissions.user_id` is ON DELETE CASCADE, so
 * deleting a departing colleague destroyed every manuscript they had submitted;
 * `change_logs.user_id` is too, so it also erased every edit they had ever made
 * to OTHER people's submissions, leaving those curators with gaps in a history
 * that is meant to be a complete record. The S3 folder and any queued jobs were
 * left behind pointing at an id that no longer resolved.
 *
 * So the row stays and the identity goes:
 *
 *   - the email is replaced by an unguessable, non-routable address. It has to
 *     stay unique (the column is), and it must not be reversible — an
 *     `sha256(email)` would let anyone holding the address confirm the account
 *     existed, so it is random, not derived.
 *   - the password hash and the Auth0 link are erased, which is what actually
 *     ends the ability to sign in. `deleted` alone would be a flag to forget to
 *     check somewhere.
 *   - the name becomes a tombstone, so history reads "Deleted user" rather than
 *     blank.
 *   - team memberships go, so the account stops conferring visibility of the
 *     lab's submissions to anything that resolves teams by user id.
 *   - live refresh tokens are revoked, so an open session dies at its next
 *     15-minute refresh instead of surviving for the rest of the 7-day window.
 *
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

    if (user.deleted) {
      throw new ConflictError('User is already deleted');
    }

    await sequelize.transaction(async (transaction) => {
      user.email = `deleted-${crypto.randomBytes(16).toString('hex')}@deleted.invalid`;
      user.name = 'Deleted user';
      user.passwordHash = null;
      user.auth0Sub = null;
      user.deleted = true;
      user.deletedAt = new Date();
      await user.save({ transaction });

      await UserTeam.destroy({ where: { userId: user.id }, transaction });

      await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: 'account_deleted' },
        { where: { userId: user.id, revokedAt: null }, transaction }
      );
    });

    logger.info('User anonymised by admin', { deletedUserId: user.id, deletedBy: req.userId });

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
