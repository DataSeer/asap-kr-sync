/**
 * Softcite (software-mentions) API Configuration
 * Docker image: lfoppiano/software-mentions:0.8.2
 * Endpoints:
 *   POST /service/annotateSoftwarePDF — multipart, field "input" = PDF file
 *   POST /service/processSoftwareText — URL-encoded, field "text" = plain text
 */

const logger = require('../utils/logger');

module.exports = {
  // API Base URL
  baseUrl: process.env.SOFTCITE_API_BASE_URL || 'http://localhost:8050',

  // Request timeout (10 minutes — PDF processing can be slow)
  timeout: parseInt(process.env.SOFTCITE_API_TIMEOUT, 10) || 600000,

  // Whether the service is disabled (skips software detection)
  disabled: process.env.SOFTCITE_API_ENABLED !== 'true',

  // Retry configuration
  retryConfig: {
    maxRetries: 2,
    retryDelay: 5000,
    retryDelayMultiplier: 2
  },

  // Check if Softcite API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.baseUrl;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('Softcite API: DISABLED (software detection skipped)');
    } else {
      logger.info('Softcite API: configured', { baseUrl: this.baseUrl });
    }
  }
};
