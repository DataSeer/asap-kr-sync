/**
 * DAS Extraction API Configuration (Google Gemini)
 *
 * Calls Gemini with the manuscript markdown and a section-extraction prompt
 * (see src/backend/data/prompts/das-extraction.txt) to copy out the
 * Data Availability Statement verbatim.
 *
 * Replaces the previous Modal-hosted llama fine-tune endpoint
 * (PDF_DAS_EXTRACTOR_*). Markdown comes from the Markdown Convert job's
 * S3-stored output, so this service depends on that job — see
 * orchestrator PIPELINE.
 *
 * Authentication: per-service API key via DAS_EXTRACTION_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');

module.exports = {
  // Gemini API key (per-service so it can be rate-limited / rotated
  // independently of the other Gemini-using detectors)
  apiKey: process.env.DAS_EXTRACTION_GEMINI_API_KEY || '',

  // Model to use. 2.5-flash is plenty for verbatim section extraction and
  // keeps cost / latency low.
  model: process.env.DAS_EXTRACTION_GEMINI_MODEL || 'gemini-2.5-flash',

  // Which section to ask the prompt for. Defaults to the Data Availability
  // Statement, matching the previous Modal endpoint's `section=das` value.
  // The prompt supports the same set of section types as the Modal endpoint.
  section: process.env.DAS_EXTRACTION_SECTION || 'das',

  // Request timeout. Verbatim extraction is fast — 2 minutes is generous.
  timeout: parseInt(process.env.DAS_EXTRACTION_API_TIMEOUT, 10) || 120000,

  // Whether the service is disabled. Defaults to enabled so existing
  // submissions keep getting their DAS extracted; flip to 'false' to skip.
  disabled: process.env.DAS_EXTRACTION_ENABLED === 'false',

  // Check if the API is configured and enabled
  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('DAS Extraction: DISABLED');
    } else if (!this.apiKey) {
      logger.warn('DAS Extraction: API key not configured (DAS_EXTRACTION_GEMINI_API_KEY)');
    } else {
      logger.info('DAS Extraction: configured', { model: this.model, section: this.section });
    }
  }
};
