/**
 * OpenAlex API Configuration
 * Free scholarly metadata API — no key needed.
 * Endpoint: GET /works/doi:{doi}
 */

const logger = require('../utils/logger');

module.exports = {
  // API Base URL
  baseUrl: 'https://api.openalex.org',

  // Mailto for polite pool (gets higher rate limits)
  mailto: process.env.OPENALEX_MAILTO || '',

  // Request timeout
  timeout: parseInt(process.env.OPENALEX_API_TIMEOUT, 10) || 10000,

  // Whether the service is disabled
  disabled: process.env.OPENALEX_API_ENABLED !== 'true',

  // Check if OpenAlex API is configured and enabled
  isConfigured() {
    return !this.disabled;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('OpenAlex API: DISABLED (ORCID enrichment skipped)');
    } else {
      logger.info('OpenAlex API: configured', { mailto: this.mailto || '(none)' });
    }
  }
};
