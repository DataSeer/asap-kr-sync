/**
 * Software Detection — LM pass configuration (Google Gemini)
 *
 * Software detection historically used Softcite alone: a purpose-built NER
 * service that recognises tool NAMES written in prose. Measured against the DS
 * curators' reports it recovered 25% of software resources — the worst recall
 * of any module — and 253 of the 291 misses carried a machine-readable
 * identifier (143 of them an `RRID:SCR_…`) sitting in plain text. Softcite
 * cannot see those, because they are identifiers rather than names.
 *
 * This config governs an LM pass that runs ALONGSIDE Softcite, over the
 * converted markdown, and is unioned with it — never a replacement. Softcite's
 * precision is good, the two disagree in useful ways, and agreement between
 * them is itself a confidence signal.
 *
 * With this disabled the module behaves exactly as before (Softcite only).
 *
 * Authentication: per-service API key via SOFTWARE_DETECTION_GEMINI_API_KEY.
 */

const logger = require('../utils/logger');

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
  apiKey: process.env.SOFTWARE_DETECTION_GEMINI_API_KEY || '',

  // Model to use
  model: process.env.SOFTWARE_DETECTION_GEMINI_MODEL || 'gemini-2.5-flash',

  // Request timeout
  timeout: parseInt(process.env.SOFTWARE_DETECTION_API_TIMEOUT, 10) || 300000,

  // Off by default: Softcite-only remains the shipped behaviour until this pass
  // has been measured against the curated reports.
  disabled: process.env.SOFTWARE_DETECTION_LM_ENABLED !== 'true',

  isConfigured() {
    return !this.disabled && isRealKey(this.apiKey);
  },

  logStatus() {
    if (this.disabled) {
      logger.info('Software Detection LM pass: DISABLED (Softcite only)');
    } else if (!isRealKey(this.apiKey)) {
      logger.warn('Software Detection LM pass: No API key configured (SOFTWARE_DETECTION_GEMINI_API_KEY) — Softcite only');
    } else {
      logger.info('Software Detection LM pass: configured', { model: this.model });
    }
  }
};
