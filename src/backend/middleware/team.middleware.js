/**
 * Team-Based Access Control Middleware
 *
 * Implements the per-record and list scoping rules for submissions:
 *  - admin / ds_annotator: full access, no filter.
 *  - asap_pm: access to submissions whose `team` is in the PM's team list.
 *    Edge case — if the PM has no teams, they can only see/touch submissions
 *    whose team is NULL. This lets a "general" PM with no team assignment
 *    handle teamless submissions without seeing other teams' work.
 *  - author: access to submissions whose `userId` matches their own.
 *
 * The same rules are mirrored in the frontend auth store
 * (`canEditSubmission`, `canAccessSubmission`) for UI gating; this file is the
 * authoritative server-side enforcement.
 */

const { Op } = require('sequelize');
const { Submission } = require('../models');
const { AuthorizationError, NotFoundError } = require('../utils/errors');
const { ROLES } = require('../config/constants');

/**
 * Check if user can access a specific submission
 * - Authors can only access their own submissions
 * - ASAP PMs can only access submissions from their team
 * - DS Annotators and Admins can access all submissions
 */
async function canAccessSubmission(req, res, next) {
  try {
    if (!req.user) {
      return next(new AuthorizationError('Authentication required'));
    }

    const submissionId = req.params.id || req.params.submissionId;
    if (!submissionId) {
      return next();
    }

    const submission = await Submission.findByPk(submissionId);
    if (!submission) {
      return next(new NotFoundError('Submission'));
    }

    const { role, id: userId, teams: userTeams = [] } = req.user;

    // Admin and DS Annotator can access all
    if (role === ROLES.ADMIN || role === ROLES.DS_ANNOTATOR) {
      req.submission = submission;
      return next();
    }

    // ASAP PM can only access their teams' submissions (or no-team submissions if PM has no teams)
    if (role === ROLES.ASAP_PM) {
      if (userTeams.length === 0) {
        // PM has no teams - can only access submissions with no team
        if (submission.team !== null) {
          return next(new AuthorizationError('You can only access submissions without a team assigned'));
        }
      } else {
        // PM has teams - can only access submissions from their teams
        if (!userTeams.includes(submission.team)) {
          return next(new AuthorizationError('You can only access submissions from your teams'));
        }
      }
      req.submission = submission;
      return next();
    }

    // Author can only access their own submissions
    if (role === ROLES.AUTHOR) {
      if (submission.userId !== userId) {
        return next(new AuthorizationError('You can only access your own submissions'));
      }
      req.submission = submission;
      return next();
    }

    return next(new AuthorizationError('Access denied'));
  } catch (error) {
    next(error);
  }
}

/**
 * Build query filter based on user role
 * @param {object} user - User object from request
 * @returns {object} Sequelize where clause
 */
function buildSubmissionFilter(user) {
  if (!user) {
    return { id: null }; // Return empty result
  }

  const { role, id: userId, teams: userTeams = [] } = user;

  switch (role) {
    case ROLES.ADMIN:
    case ROLES.DS_ANNOTATOR:
      // Can see all submissions
      return {};

    case ROLES.ASAP_PM:
      // Can only see their teams' submissions (or submissions with no team if PM has no teams)
      if (userTeams.length === 0) {
        // PM has no teams - can only see submissions with no team assigned
        return { team: { [Op.is]: null } };
      }
      return { team: { [Op.in]: userTeams } };

    case ROLES.AUTHOR:
      // Can only see their own submissions
      return { userId };

    default:
      return { id: null }; // Unknown role, return empty
  }
}

/**
 * Middleware to attach submission filter to request
 */
function attachSubmissionFilter(req, res, next) {
  req.submissionFilter = buildSubmissionFilter(req.user);
  next();
}

module.exports = {
  canAccessSubmission,
  buildSubmissionFilter,
  attachSubmissionFilter
};
