/**
 * PDF Analysis — the consolidator's feature flag, and nothing else.
 *
 * PDF Analysis is not an external API call. It regroups every detector's items,
 * coarse-dedups them, and asks an LM to consolidate the candidates into the
 * Generated KRT — and that LM call is configured by `krt-generation-api`, not
 * here. So "configured" means only "the flag is on"; there is no key or URL to
 * validate.
 *
 * It used to be a remote service. The client, its base URL, API key, timeout,
 * endpoints and retry policy all outlived it: nothing required the client
 * module, and nothing read any field but `isConfigured()`. They are gone rather
 * than kept "for compatibility", because dead configuration is worse than
 * absent configuration — someone sets it, nothing happens, and the documented
 * behaviour is a lie.
 */

module.exports = {
  // Opt-in, like every other module: off unless explicitly switched on.
  disabled: process.env.PDF_ANALYSIS_ENABLED !== 'true',

  isConfigured() {
    return !this.disabled;
  },

  logStatus() {
    const logger = require('../utils/logger');
    if (this.isConfigured()) logger.info('PDF Analysis: enabled (in-app consolidator)');
    else logger.warn('PDF Analysis: disabled (PDF_ANALYSIS_ENABLED)');
  }
};
