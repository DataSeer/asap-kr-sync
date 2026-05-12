/**
 * ORCID Public API Configuration
 * Optional fallback for author ORCID lookup by name + affiliation.
 * Endpoint: GET /v3.0/search/?q=...
 */

const logger = require('../utils/logger');

module.exports = {
  // API Base URL
  baseUrl: 'https://pub.orcid.org/v3.0',

  // Request timeout per search
  timeout: parseInt(process.env.ORCID_API_TIMEOUT, 10) || 5000,

  // Whether the service is disabled
  disabled: process.env.ORCID_API_ENABLED !== 'true',

  // Check if ORCID API is configured and enabled
  isConfigured() {
    return !this.disabled;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('ORCID API: DISABLED (fallback lookup skipped)');
    } else {
      logger.info('ORCID API: configured');
    }
  }
};
