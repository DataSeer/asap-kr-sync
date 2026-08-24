/**
 * Datasets Detection API Configuration (Google Gemini)
 *
 * Uses Gemini to detect dataset mentions in manuscript text.
 * Authentication: DATASETS_DETECTION_GEMINI_API_KEY, falling back to the
 * shared GEMINI_API_KEY. The langextract child process is handed the
 * resolved value, because it reads the per-service name directly.
 */

const logger = require('../utils/logger');
const { geminiKey, geminiModel } = require('./gemini');

module.exports = {
  // Gemini API key (per-service)
  apiKey: geminiKey('DATASETS_DETECTION'),

  // Model to use
  model: geminiModel('DATASETS_DETECTION'),

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
      logger.warn('Datasets Detection API: no API key configured (DATASETS_DETECTION_GEMINI_API_KEY or GEMINI_API_KEY)');
    } else {
      logger.info('Datasets Detection API: configured', { model: this.model });
    }
  }
};
