/**
 * PDF DAS (Data Availability Statement) Extractor API Configuration
 *
 * Calls the Modal-hosted section-extraction endpoint
 *   https://api.modal.com
 * which runs DataSeer/das-extraction-lm-Llama-3.1-8B-full-ft on the article
 * and returns the requested section's text verbatim.
 *
 * Request: multipart/form-data with three fields:
 *   article    — PDF file
 *   section    — which section to extract (default 'das')
 *   converter  — markitdown (default, faster) or docling (higher recall on
 *                 funding_statement / patient_informed_consent_statement)
 * Auth: X-API-Key header.
 */

const logger = require('../utils/logger');

const DEFAULT_BASE_URL = 'https://api.modal.com';

module.exports = {
  // API Base URL (full endpoint URL)
  baseUrl: process.env.PDF_DAS_EXTRACTOR_API_BASE_URL || DEFAULT_BASE_URL,

  // API Key (X-API-Key header)
  apiKey: process.env.PDF_DAS_EXTRACTOR_API_KEY,

  // Which section to extract. 'das' covers the Data Availability Statement;
  // other supported values (per the endpoint's docs) include funding_statement,
  // patient_informed_consent_statement, etc.
  section: process.env.PDF_DAS_EXTRACTOR_SECTION || 'das',

  // Which converter the model should run on the PDF before extraction.
  // markitdown is the default; docling has higher recall on harder sections.
  converter: process.env.PDF_DAS_EXTRACTOR_CONVERTER || 'markitdown',

  // Request timeout (5 minutes default)
  timeout: parseInt(process.env.PDF_DAS_EXTRACTOR_API_TIMEOUT, 10) || 300000,

  // Whether the extractor is disabled
  disabled: process.env.PDF_DAS_EXTRACTOR_ENABLED !== 'true',

  // Retry configuration
  retryConfig: {
    maxRetries: 2,
    retryDelay: 2000,
    retryDelayMultiplier: 2
  },

  // Check if API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey && !!this.baseUrl;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('PDF DAS Extractor: DISABLED');
    } else if (!this.apiKey) {
      logger.warn('PDF DAS Extractor: API key not configured');
    } else {
      logger.info('PDF DAS Extractor: configured', {
        baseUrl: this.baseUrl,
        section: this.section,
        converter: this.converter
      });
    }
  }
};
