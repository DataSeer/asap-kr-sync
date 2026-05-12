/**
 * Error Handling Middleware
 */

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Global error handler
 */
function errorMiddleware(err, req, res, next) {
  // Log error
  if (err.isOperational) {
    const logData = {
      code: err.code,
      message: err.message,
      path: req.path,
      method: req.method
    };
    // Include validation errors details for debugging
    if (err.errors && err.errors.length > 0) {
      logData.validationErrors = err.errors;
    }
    logger.warn('Operational error:', logData);
  } else {
    logger.error('Unexpected error:', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method
    });
  }

  // Handle Sequelize errors
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
      details: err.errors.map(e => ({
        field: e.path,
        message: e.message
      }))
    });
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      error: 'Resource already exists',
      code: 'CONFLICT_ERROR',
      details: err.errors.map(e => ({
        field: e.path,
        message: e.message
      }))
    });
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(400).json({
      error: 'Invalid reference',
      code: 'FOREIGN_KEY_ERROR',
      message: 'Referenced resource does not exist'
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTHENTICATION_ERROR'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expired',
      code: 'AUTHENTICATION_ERROR'
    });
  }

  // Handle Joi validation errors
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
      details: err.details.map(d => ({
        field: d.path.join('.'),
        message: d.message
      }))
    });
  }

  // Handle custom AppError
  if (err instanceof AppError) {
    const response = {
      error: err.message,
      code: err.code
    };

    if (err.errors) {
      response.details = err.errors;
    }

    return res.status(err.statusCode).json(response);
  }

  // Handle unknown errors
  const statusCode = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(statusCode).json({
    error: message,
    code: 'INTERNAL_ERROR'
  });
}

module.exports = errorMiddleware;
