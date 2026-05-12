/**
 * Materials Detection API Configuration (Google Gemini)
 *
 * Uses Gemini to detect lab material mentions in manuscript PDFs.
 * Authentication: per-service API key via MATERIALS_DETECTION_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');

module.exports = {
  // Gemini API key (per-service)
  apiKey: process.env.MATERIALS_DETECTION_GEMINI_API_KEY || '',

  // Model to use
  model: process.env.MATERIALS_DETECTION_GEMINI_MODEL || 'gemini-2.5-flash',

  // Request timeout (5 minutes — PDF processing can be slow)
  timeout: parseInt(process.env.MATERIALS_DETECTION_API_TIMEOUT, 10) || 300000,

  // Whether the service is disabled
  disabled: process.env.MATERIALS_DETECTION_ENABLED !== 'true',

  // Check if the API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('Materials Detection API: DISABLED (materials detection skipped)');
    } else if (!this.apiKey) {
      logger.warn('Materials Detection API: No API key configured (MATERIALS_DETECTION_GEMINI_API_KEY)');
    } else {
      logger.info('Materials Detection API: configured', { model: this.model });
    }
  }
};
