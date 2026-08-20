/**
 * Profile Controller
 * Handles user profile operations
 */

const { User, UserTeam } = require('../models');
const { ValidationError } = require('../utils/errors');
const authService = require('../services/auth/auth.service');
const logger = require('../utils/logger');

/** The cookie the refresh token travels in. Mirrors auth.controller. */
const REFRESH_COOKIE = 'asap_kr_refresh';

/**
 * Get current user's profile
 * GET /api/profile
 */
async function getProfile(req, res, next) {
  try {
    const user = await User.findByPk(req.userId, {
      attributes: ['id', 'email', 'name', 'role', 'createdAt', 'updatedAt', 'auth0Sub'],
      include: [{
        model: UserTeam,
        as: 'userTeams',
        attributes: ['team']
      }]
    });

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
 * Update current user's profile
 * PATCH /api/profile
 */
async function updateProfile(req, res, next) {
  try {
    const user = await User.findByPk(req.userId);
    const { name, currentPassword, newPassword } = req.validatedBody;

    // Update name if provided
    if (name) {
      user.name = name;
    }

    // Handle password change
    if (newPassword) {
      // Auth0 users cannot change their password locally
      if (user.auth0Sub) {
        throw new ValidationError('Password is managed by your identity provider');
      }

      if (!currentPassword) {
        throw new ValidationError('Current password is required to change password');
      }

      // Verify current password
      const isValid = await user.verifyPassword(currentPassword);
      if (!isValid) {
        throw new ValidationError('Current password is incorrect');
      }

      user.passwordHash = newPassword;
    }

    await user.save();

    // Changing a password must end the OTHER sessions, or it does not do what
    // the person believes it does: a stolen session survived the change for the
    // rest of the 7-day refresh window — which is the whole reason someone
    // changes a password in a hurry.
    //
    // The session doing the changing is spared. Signing users out of the
    // browser they are typing in would be a bug wearing security's clothes, and
    // it teaches people not to change their password.
    if (newPassword) {
      const revoked = await authService.revokeAllForUser(user.id, 'password_changed', {
        exceptRawToken: req.cookies?.[REFRESH_COOKIE] || null
      });
      logger.info('Password changed — other sessions signed out', { userId: user.id, revoked });
    }

    logger.info('User updated their profile', { userId: user.id });

    // Fetch updated user with teams
    const updatedUser = await User.findByPk(req.userId, {
      attributes: ['id', 'email', 'name', 'role', 'createdAt', 'updatedAt', 'auth0Sub'],
      include: [{
        model: UserTeam,
        as: 'userTeams',
        attributes: ['team']
      }]
    });

    const userData = updatedUser.toJSON();
    userData.teams = userData.userTeams ? userData.userTeams.map(ut => ut.team) : [];
    delete userData.userTeams;

    res.json({ user: userData });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProfile,
  updateProfile
};
