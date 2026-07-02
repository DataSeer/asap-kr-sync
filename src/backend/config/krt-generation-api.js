/**
 * KRT Generation API Configuration (Google Gemini)
 *
 * PDF Analysis step b: after the detections are regrouped/deduplicated, an LM
 * consolidates them into the final Generated KRT (cleaning, merging near-dups,
 * dropping non-resources), with a reason per line. LM-primary with a rules
 * fallback (mergeDetections) when not configured, so the pipeline always
 * produces a Generated KRT.
 */

const logger = require('../utils/logger');

module.exports = {
  apiKey: process.env.KRT_GENERATION_GEMINI_API_KEY || '',
  model: process.env.KRT_GENERATION_GEMINI_MODEL || 'gemini-2.5-flash',
  timeout: parseInt(process.env.KRT_GENERATION_API_TIMEOUT, 10) || 300000,
  disabled: process.env.KRT_GENERATION_ENABLED !== 'true',

  isConfigured() {
    return !this.disabled && !!this.apiKey;
  },

  logStatus() {
    if (this.disabled) {
      logger.info('KRT Generation LM: DISABLED (PDF Analysis falls back to rule-based merge)');
    } else if (!this.apiKey) {
      logger.warn('KRT Generation LM: No API key configured (KRT_GENERATION_GEMINI_API_KEY)');
    } else {
      logger.info('KRT Generation LM: configured', { model: this.model });
    }
  }
};
