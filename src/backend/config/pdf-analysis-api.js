/**
 * PDF Analysis API Configuration
 * Uses API Key for authentication
 */

const logger = require('../utils/logger');

module.exports = {
  // API Base URL
  baseUrl: process.env.PDF_ANALYSIS_API_BASE_URL || 'https://api.modal.com',

  // API Key (Bearer token)
  apiKey: process.env.PDF_ANALYSIS_API_KEY,

  // Request timeout (5 minutes default for PDF analysis)
  timeout: parseInt(process.env.PDF_ANALYSIS_API_TIMEOUT, 10) || 300000,

  // API endpoints
  endpoints: {
    analyze: '/v1/analyze',
    status: '/v1/status'
  },

  // Whether the service is disabled
  disabled: process.env.PDF_ANALYSIS_ENABLED !== 'true',

  // Retry configuration
  retryConfig: {
    maxRetries: 3,
    retryDelay: 1000,
    retryDelayMultiplier: 2
  },

  // Whether the consolidator is enabled. PDF Analysis is no longer an
  // external API call — it's the in-app KRT consolidator that merges every
  // detection's output. So "configured" here means "feature flag is on";
  // there's no API key / base URL to validate.
  isConfigured() {
    return !this.disabled;
  },

  // Get authorization header
  getAuthHeader() {
    if (!this.apiKey) {
      logger.warn('PDF Analysis API: API key not configured');
      return null;
    }
    return `Bearer ${this.apiKey}`;
  }
};
