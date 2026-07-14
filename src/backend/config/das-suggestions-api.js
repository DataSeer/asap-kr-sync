/**
 * DAS Suggestions API Configuration (Google Gemini)
 *
 * Uses Gemini to check a submission's Data/Code Availability Statement against
 * the ASAP rulebook and return a per-rule verdict (applies / not, with a
 * reason). Authentication: per-service API key via
 * DAS_SUGGESTIONS_GEMINI_API_KEY. When not configured the frontend falls back
 * to the legacy hardcoded rules.
 */

const logger = require('../utils/logger');

module.exports = {
  // Gemini API key (per-service)
  apiKey: process.env.DAS_SUGGESTIONS_GEMINI_API_KEY || '',

  // Model to use
  model: process.env.DAS_SUGGESTIONS_GEMINI_MODEL || 'gemini-2.5-flash',

  // Request timeout
  timeout: parseInt(process.env.DAS_SUGGESTIONS_API_TIMEOUT, 10) || 120000,

  // Whether the service is disabled
  disabled: process.env.DAS_SUGGESTIONS_ENABLED !== 'true',

  // Check if the API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('DAS Suggestions API: DISABLED (availability suggestions fall back to legacy rules)');
    } else if (!this.apiKey) {
      logger.warn('DAS Suggestions API: No API key configured (DAS_SUGGESTIONS_GEMINI_API_KEY)');
    } else {
      logger.info('DAS Suggestions API: configured', { model: this.model });
    }
  }
};
