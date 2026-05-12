/**
 * GROBID API Configuration
 * Machine learning library for extracting structured data from scholarly PDFs.
 * Endpoint: POST /api/processHeaderDocument — multipart, field "input" = PDF file
 */

const logger = require('../utils/logger');

module.exports = {
  // API Base URL (include path prefix if proxied, e.g. https://host/grobid)
  baseUrl: process.env.GROBID_API_BASE_URL || 'http://localhost:8070',

  // Request timeout (30s — header parsing is fast)
  timeout: parseInt(process.env.GROBID_API_TIMEOUT, 10) || 30000,

  // Whether the service is disabled
  disabled: process.env.GROBID_API_ENABLED !== 'true',

  // Retry configuration
  retryConfig: {
    maxRetries: 2,
    retryDelay: 2000,
    retryDelayMultiplier: 2
  },

  // Check if GROBID API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.baseUrl;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('GROBID API: DISABLED (ORCID extraction skipped)');
    } else {
      logger.info('GROBID API: configured', { baseUrl: this.baseUrl });
    }
  }
};
