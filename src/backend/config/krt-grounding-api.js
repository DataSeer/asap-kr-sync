/**
 * KRT Grounding API Configuration (Google Gemini)
 *
 * Grounding reconciles the author's KRT against the detectors' candidate pool.
 * Its deterministic matcher needs no external service and always runs; this
 * config only governs the optional LM "second look" — one batched search pass
 * over the author rows that matched nothing.
 *
 * With the LM unconfigured the module still completes: unmatched rows simply
 * stay `not_detected`, which is a truthful verdict, just a less informed one.
 *
 * Authentication: KRT_GROUNDING_GEMINI_API_KEY, falling back to the shared
 * GEMINI_API_KEY. Placeholder values are rejected by geminiKey().
 */

const logger = require('../utils/logger');
const { geminiKey, geminiModel, isRealKey } = require('./gemini');

/**
 * Placeholder values shipped in .env.example. Treating one as a real key makes
 * the module report itself configured and then fail every call with a 400 —
 * which is exactly what happened when this variable was copied but not filled.
 */
// Placeholder rejection lives in config/gemini.js now, so all nine modules
// agree on what counts as a key -- and geminiKey() has already applied it to
// the value below.


module.exports = {
  // Gemini API key (per-service)
  apiKey: geminiKey('KRT_GROUNDING'),

  // Model to use
  model: geminiModel('KRT_GROUNDING'),

  // Request timeout
  timeout: parseInt(process.env.KRT_GROUNDING_API_TIMEOUT, 10) || 180000,

  // Whether the LM second look is disabled. Defaults to ON when a key is
  // present — unlike the detectors, this module degrades rather than failing,
  // so there is no fallback path to protect.
  disabled: process.env.KRT_GROUNDING_SECOND_LOOK_ENABLED === 'false',

  // Check if the second look is configured and enabled
  isConfigured() {
    return !this.disabled && isRealKey(this.apiKey);
  },

  // Log configuration status
  logStatus() {
    if (this.disabled) {
      logger.info('KRT Grounding second look: DISABLED (deterministic matching still runs)');
    } else if (!isRealKey(this.apiKey)) {
      logger.warn('KRT Grounding second look: No API key configured (KRT_GROUNDING_GEMINI_API_KEY) — deterministic matching still runs');
    } else {
      logger.info('KRT Grounding second look: configured', { model: this.model });
    }
  }
};
