/**
 * Authentication Middleware
 * Supports dual verification: local JWT and Auth0 JWKS
 */

const jwt = require('jsonwebtoken');
const { User, UserTeam } = require('../models');
const { AuthenticationError } = require('../utils/errors');
const auth0Service = require('../services/auth/auth0.service');
const logger = require('../utils/logger');

/**
 * Fetch user with teams and build standard user data object
 * @param {object} query - Sequelize where clause
 * @returns {Promise<object>} User data with teams array
 */
async function fetchUserWithTeams(query) {
  const user = await User.findOne({
    where: query,
    attributes: ['id', 'email', 'name', 'role', 'auth0Sub'],
    include: [{
      model: UserTeam,
      as: 'userTeams',
      attributes: ['team']
    }]
  });

  if (!user) return null;

  const userData = user.toJSON();
  userData.teams = userData.userTeams ? userData.userTeams.map(ut => ut.team) : [];
  delete userData.userTeams;

  return { user, userData };
}

// Cookie name for the local-JWT access token. Matches auth.controller.js.
const SESSION_COOKIE = 'asap_kr_session';

/**
 * Extract the access token from the request. Cookie-only — the API does
 * not accept Authorization headers since phase 6.2 (the SPA is the only
 * /api consumer; external/Bearer access is not supported).
 */
function extractToken(req) {
  return req.cookies?.[SESSION_COOKIE] || null;
}

/**
 * Verify JWT token and attach user to request.
 * Dual strategy: try local JWT first, then Auth0 JWKS (covers any
 * legacy Auth0 access token that might still travel via the cookie).
 */
async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      throw new AuthenticationError('No token provided');
    }

    // Strategy 1: Try local JWT verification
    let result = await tryLocalVerification(token);

    // Strategy 2: Try Auth0 JWKS verification
    if (!result && auth0Service.isConfigured()) {
      result = await tryAuth0Verification(token);
    }

    if (!result) {
      throw new AuthenticationError('Invalid token');
    }

    req.user = result.userData;
    req.userId = result.user.id;

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Try to verify token as a local JWT
 * @param {string} token
 * @returns {Promise<object|null>} User result or null if verification fails
 */
async function tryLocalVerification(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await fetchUserWithTeams({ id: decoded.userId });
    if (!result) {
      throw new AuthenticationError('User not found');
    }
    return result;
  } catch (err) {
    if (err instanceof AuthenticationError) throw err;
    // Local verification failed, return null to try Auth0
    return null;
  }
}

/**
 * Try to verify token as an Auth0 JWT via JWKS
 * @param {string} token
 * @returns {Promise<object|null>} User result or null if verification fails
 */
async function tryAuth0Verification(token) {
  try {
    const decoded = await auth0Service.verifyAccessToken(token);
    const result = await fetchUserWithTeams({ auth0Sub: decoded.sub });
    if (!result) {
      logger.warn('Auth0 token valid but no linked user found', { sub: decoded.sub });
      throw new AuthenticationError('User not found');
    }
    return result;
  } catch (err) {
    if (err instanceof AuthenticationError) throw err;
    logger.debug('Auth0 token verification failed', { error: err.message });
    return null;
  }
}

/**
 * Optional authentication - doesn't fail if no token
 */
async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return next();
    }

    // Try local JWT first
    let result = await tryLocalVerification(token).catch((err) => {
      logger.debug('optionalAuth: local verification failed', { error: err.message });
      return null;
    });

    // Try Auth0 if local fails
    if (!result && auth0Service.isConfigured()) {
      result = await tryAuth0Verification(token).catch((err) => {
        logger.debug('optionalAuth: Auth0 verification failed', { error: err.message });
        return null;
      });
    }

    if (result) {
      req.user = result.userData;
      req.userId = result.user.id;
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  authenticate,
  optionalAuth
};
