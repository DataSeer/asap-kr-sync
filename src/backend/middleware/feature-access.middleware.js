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

// A `canManageJobs` guard used to live here, applied to exactly one route:
// POST /jobs/:jobType/advance. It was removed rather than left unused, because
// an exported guard nothing applies reads as protection that is not there.
//
// Advancing only ever starts a job the pipeline parked at 'pending_input'
// awaiting the user's own input — the orchestrator rejects every other status —
// so restricting it to staff stalled any submission whose Availability
// Statement had to be entered by hand. The route's own comment carries the
// reasoning. Job actions that really are staff-only (the cross-submission
// queue admin) sit behind requireRole(ADMIN) in job-admin.routes.js, and the
// frontend keeps its own `canManageJobs` flag for the restart controls.

module.exports = {
  canViewJobInternals
};
