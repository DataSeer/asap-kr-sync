/**
 * KRT Comparison API Configuration (Google Gemini)
 *
 * Uses Gemini to compare the author's KRT against the tool-Generated KRT and
 * produce add/update/remove suggestions. Authentication: per-service API key
 * via KRT_COMPARISON_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');

module.exports = {
  // Gemini API key (per-service)
  apiKey: process.env.KRT_COMPARISON_GEMINI_API_KEY || '',

  // Model to use
  model: process.env.KRT_COMPARISON_GEMINI_MODEL || 'gemini-2.5-flash',

  // Request timeout
  timeout: parseInt(process.env.KRT_COMPARISON_API_TIMEOUT, 10) || 300000,

  // Whether the service is disabled
  disabled: process.env.KRT_COMPARISON_ENABLED !== 'true',

  // Check if the API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('KRT Comparison API: DISABLED (suggestion generation skipped)');
    } else if (!this.apiKey) {
      logger.warn('KRT Comparison API: No API key configured (KRT_COMPARISON_GEMINI_API_KEY)');
    } else {
      logger.info('KRT Comparison API: configured', { model: this.model });
    }
  }
};
