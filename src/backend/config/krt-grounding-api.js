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
 * Authentication: per-service API key via KRT_GROUNDING_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');
const { geminiKey, geminiModel } = require('./gemini');

/**
 * Placeholder values shipped in .env.example. Treating one as a real key makes
 * the module report itself configured and then fail every call with a 400 —
 * which is exactly what happened when this variable was copied but not filled.
 */
const PLACEHOLDER_KEYS = new Set(['your_gemini_api_key', 'your_api_key', 'changeme', '']);

/** @param {string} key @returns {boolean} */
function isRealKey(key) {
  return !PLACEHOLDER_KEYS.has(String(key || '').trim());
}


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
