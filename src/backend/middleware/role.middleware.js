/**
 * Role-Based Access Control Middleware
 */

const { AuthorizationError } = require('../utils/errors');
const { ROLES } = require('../config/constants');

/**
 * Require specific roles to access route
 * @param {...string} allowedRoles - Roles that can access the route
 * @returns {Function} Express middleware
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthorizationError('Authentication required'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new AuthorizationError(`Access denied. Required roles: ${allowedRoles.join(', ')}`));
    }

    next();
  };
}

/**
 * Check if user is admin
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return next(new AuthorizationError('Authentication required'));
  }

  if (req.user.role !== ROLES.ADMIN) {
    return next(new AuthorizationError('Admin access required'));
  }

  next();
}

/**
 * Check if user can create submissions (all authenticated users)
 */
function canCreateSubmission(req, res, next) {
  if (!req.user) {
    return next(new AuthorizationError('Authentication required'));
  }

  // All authenticated users can create submissions
  next();
}

module.exports = {
  requireRole,
  requireAdmin,
  canCreateSubmission
};
