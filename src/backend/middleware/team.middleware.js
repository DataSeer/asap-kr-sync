/**
 * Team-Based Access Control Middleware
 *
 * Visibility is TEAM-based (a team is a lab, keyed by leader name). A
 * submission's `project` (2-letter grant code) is NOT an access key — it is
 * only a filter. A submission is "related to" the teams of its OWNER, so:
 *
 *  - admin / ds_annotator: full access, no filter.
 *  - asap_pm: their own submissions, plus any submission whose OWNER shares one
 *    of the PM's teams (their teammates). A PM with no teams sees only their
 *    own. Two teams working the same project each see only their own team's
 *    submissions, because ownership — not the project — drives visibility.
 *  - author: their own submissions only.
 *
 * Staff-owned submissions are hidden from non-staff. Admins and DS annotators
 * upload many PDFs for testing, so their own submissions would otherwise
 * surface for PMs who share a team; submissions owned by an admin/ds_annotator
 * are therefore never visible to asap_pm or author viewers. Staff hand a
 * document to a real user via the reassign-owner endpoint, after which it
 * follows the new owner's teams.
 *
 * The same rules are mirrored in the frontend auth store
 * (`canEditSubmission`, `canAccessSubmission`) for UI gating; this file is the
 * authoritative server-side enforcement.
 */

const { Op } = require('sequelize');
const { Submission, User, UserTeam } = require('../models');
const { AuthorizationError, NotFoundError } = require('../utils/errors');
const { ROLES } = require('../config/constants');

const STAFF_ROLES = [ROLES.ADMIN, ROLES.DS_ANNOTATOR];

/**
 * IDs of all staff (admin / ds_annotator) users. Used to exclude staff-owned
 * submissions from non-staff viewers.
 * @returns {Promise<string[]>}
 */
async function getStaffUserIds() {
  const staff = await User.findAll({
    where: { role: { [Op.in]: STAFF_ROLES } },
    attributes: ['id'],
    raw: true
  });
  return staff.map(u => u.id);
}

/**
 * AND a staff-owner exclusion onto a base where-clause. No-op when there are
 * no staff users (an empty NOT IN would otherwise match nothing).
 * @param {object} filter - base Sequelize where clause
 * @param {string[]} staffIds
 * @returns {object}
 */
function withStaffOwnerExclusion(filter, staffIds) {
  if (!staffIds.length) return filter;
  return { [Op.and]: [filter, { userId: { [Op.notIn]: staffIds } }] };
}

/**
 * Whether a submission's owner is a staff (admin / ds_annotator) user.
 * @param {string} ownerId
 * @returns {Promise<boolean>}
 */
async function isStaffOwned(ownerId) {
  if (!ownerId) return false;
  const count = await User.count({
    where: { id: ownerId, role: { [Op.in]: STAFF_ROLES } }
  });
  return count > 0;
}

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

    // ASAP PM: their own, plus any submission whose OWNER shares one of the
    // PM's teams. Staff-owned (test) submissions are never exposed.
    if (role === ROLES.ASAP_PM) {
      if (submission.userId === userId) {
        req.submission = submission;
        return next();
      }
      if (await isStaffOwned(submission.userId)) {
        return next(new AuthorizationError('You can only access submissions from your teams'));
      }
      const ownerSharesTeam = userTeams.length > 0 && await UserTeam.count({
        where: { userId: submission.userId, team: { [Op.in]: userTeams } }
      }) > 0;
      if (!ownerSharesTeam) {
        return next(new AuthorizationError('You can only access submissions from your teams'));
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
 * @returns {Promise<object>} Sequelize where clause
 */
async function buildSubmissionFilter(user) {
  if (!user) {
    return { id: null }; // Return empty result
  }

  const { role, id: userId, teams: userTeams = [] } = user;

  switch (role) {
    case ROLES.ADMIN:
    case ROLES.DS_ANNOTATOR:
      // Can see all submissions
      return {};

    case ROLES.ASAP_PM: {
      // Their own submissions, plus any submission whose OWNER is on one of the
      // PM's teams (their teammates). A PM with no teams sees only their own.
      // Result: { userId IN (own + teammates) } AND (not staff-owned). The list
      // controller's optional ?project= filter AND-combines and can only narrow.
      const ownerIds = new Set([userId]);
      if (userTeams.length > 0) {
        const teammates = await UserTeam.findAll({
          where: { team: { [Op.in]: userTeams } },
          attributes: ['userId'],
          raw: true
        });
        teammates.forEach(t => ownerIds.add(t.userId));
      }
      return withStaffOwnerExclusion({ userId: { [Op.in]: [...ownerIds] } }, await getStaffUserIds());
    }

    case ROLES.AUTHOR:
      // Can only see their own submissions.
      return { userId };

    default:
      return { id: null }; // Unknown role, return empty
  }
}

/**
 * Middleware to attach submission filter to request
 */
async function attachSubmissionFilter(req, res, next) {
  try {
    req.submissionFilter = await buildSubmissionFilter(req.user);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  canAccessSubmission,
  buildSubmissionFilter,
  attachSubmissionFilter
};
