/**
 * Feature-Access Middleware
 *
 * Fine-grained role checks for individual features that don't fit the broad
 * requireRole / requireAdmin pattern. These guards complement canAccessSubmission
 * (which handles ownership/team scoping) by additionally restricting which roles
 * may invoke a given action on a submission they already have access to.
 */

const { AuthorizationError } = require('../utils/errors');
const { ROLES } = require('../config/constants');

/**
 * Allow PM, ds_annotator, and admin to view technical job internals (logs,
 * raw responses, request payloads). Hidden from authors only — authors see
 * only the high-level job status in the UI.
 */
function canViewJobInternals(req, res, next) {
  if (!req.user) {
    return next(new AuthorizationError('Authentication required'));
  }
  if (req.user.role === ROLES.AUTHOR) {
    return next(new AuthorizationError('Not available for your role'));
  }
  next();
}

/**
 * Restrict job lifecycle actions (restart, retry, advance, force-run) to
 * staff (admin and ds_annotator). Authors and PMs can trigger first-time
 * analysis but not manual job management.
 */
function canManageJobs(req, res, next) {
  if (!req.user) {
    return next(new AuthorizationError('Authentication required'));
  }
  if (![ROLES.ADMIN, ROLES.DS_ANNOTATOR].includes(req.user.role)) {
    return next(new AuthorizationError('Only staff can manage background jobs'));
  }
  next();
}

module.exports = {
  canViewJobInternals,
  canManageJobs
};
