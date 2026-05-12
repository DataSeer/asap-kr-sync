/**
 * Request Validation Middleware
 */

const { validate } = require('../utils/validators');

/**
 * Create validation middleware for a specific schema
 * @param {string} schemaName - Name of the schema to validate against
 * @param {string} source - Where to find data: 'body', 'query', or 'params'
 * @returns {Function} Express middleware
 */
function validateRequest(schemaName, source = 'body') {
  return (req, res, next) => {
    try {
      const data = req[source];
      const validated = validate(schemaName, data);
      req[`validated${source.charAt(0).toUpperCase() + source.slice(1)}`] = validated;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validate request body
 */
function validateBody(schemaName) {
  return validateRequest(schemaName, 'body');
}

/**
 * Validate query parameters
 */
function validateQuery(schemaName) {
  return validateRequest(schemaName, 'query');
}

/**
 * Validate route parameters
 */
function validateParams(schemaName) {
  return validateRequest(schemaName, 'params');
}

module.exports = {
  validateRequest,
  validateBody,
  validateQuery,
  validateParams
};
