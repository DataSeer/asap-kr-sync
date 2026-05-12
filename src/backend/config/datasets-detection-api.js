/**
 * Datasets Detection API Configuration (Google Gemini)
 *
 * Uses Gemini to detect dataset mentions in manuscript text.
 * Authentication: per-service API key via DATASETS_DETECTION_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');

module.exports = {
  // Gemini API key (per-service)
  apiKey: process.env.DATASETS_DETECTION_GEMINI_API_KEY || '',

  // Model to use
  model: process.env.DATASETS_DETECTION_GEMINI_MODEL || 'gemini-2.5-flash',

  // Request timeout (5 minutes — PDF processing can be slow)
  timeout: parseInt(process.env.DATASETS_DETECTION_API_TIMEOUT, 10) || 300000,

  // Whether the service is disabled (skips datasets detection)
  disabled: process.env.DATASETS_DETECTION_ENABLED !== 'true',

  // Check if the API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('Datasets Detection API: DISABLED (datasets detection skipped)');
    } else if (!this.apiKey) {
      logger.warn('Datasets Detection API: No API key configured (DATASETS_DETECTION_GEMINI_API_KEY)');
    } else {
      logger.info('Datasets Detection API: configured', { model: this.model });
    }
  }
};
