/**
 * Protocols Detection API Configuration (Google Gemini)
 *
 * Uses Gemini to detect protocol mentions in manuscript PDFs.
 * Authentication: per-service API key via PROTOCOLS_DETECTION_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');

module.exports = {
  // Gemini API key (per-service)
  apiKey: process.env.PROTOCOLS_DETECTION_GEMINI_API_KEY || '',

  // Model to use
  model: process.env.PROTOCOLS_DETECTION_GEMINI_MODEL || 'gemini-2.5-flash',

  // Request timeout (5 minutes — PDF processing can be slow)
  timeout: parseInt(process.env.PROTOCOLS_DETECTION_API_TIMEOUT, 10) || 300000,

  // Whether the service is disabled
  disabled: process.env.PROTOCOLS_DETECTION_ENABLED !== 'true',

  // Check if the API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('Protocols Detection API: DISABLED (protocols detection skipped)');
    } else if (!this.apiKey) {
      logger.warn('Protocols Detection API: No API key configured (PROTOCOLS_DETECTION_GEMINI_API_KEY)');
    } else {
      logger.info('Protocols Detection API: configured', { model: this.model });
    }
  }
};
