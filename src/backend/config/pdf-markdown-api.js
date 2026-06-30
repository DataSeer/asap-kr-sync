/**
 * PDF-to-Markdown API Configuration
 *
 * Supports two providers:
 * - "markitdown": Local MarkItDown Python subprocess (no HTTP, no URL needed)
 * - "modal" (default): Remote Modal API endpoint using Docling
 */

const logger = require('../utils/logger');

module.exports = {
  // Provider: "markitdown" (local subprocess) or "modal" (remote API)
  provider: process.env.PDF_MARKDOWN_PROVIDER || 'modal',

  // Modal/Docling configuration (remote API)
  modal: {
    url: process.env.PDF_MARKDOWN_MODAL_API_URL || '',
    apiKey: process.env.PDF_MARKDOWN_MODAL_API_KEY || '',
    converter: process.env.PDF_MARKDOWN_MODAL_CONVERTER || 'docling'
  },

  // Request timeout (2 minutes — PDF conversion can be slow for large documents)
  timeout: parseInt(process.env.PDF_MARKDOWN_TIMEOUT, 10) || 120000,

  // Markdown filter: a post-conversion step that drops numeric data-matrix blocks
  // (embedded supplementary tables) while preserving prose and resource tables, so
  // oversized markdown doesn't break/slow the text detectors. Keep-biased — see
  // services/pdf/markdown-filter.service.js.
  filter: {
    // Master switch. Disabled by default — validate via the eval A/B first.
    enabled: process.env.MARKDOWN_FILTER_ENABLED === 'true',
    // Trigger condition: only filter when the markdown exceeds this many chars,
    // so normal-sized documents are passed through untouched. 0 = always filter.
    minChars: parseInt(process.env.MARKDOWN_FILTER_MIN_CHARS, 10) || 300000,
    // A block is kept when its letters/total-chars ratio is at/above this (prose
    // ≈0.6-0.8, numeric matrices ≈0). Lower = more aggressive dropping.
    langRatio: parseFloat(process.env.MARKDOWN_FILTER_LANG_RATIO) || 0.30
  },

  // Whether the service is disabled
  disabled: process.env.PDF_MARKDOWN_ENABLED !== 'true',

  /**
   * Check if the service is configured and enabled
   * @returns {boolean}
   */
  isConfigured() {
    if (this.disabled) return false;
    if (this.provider === 'modal') return !!this.modal.url;
    // MarkItDown runs as a local subprocess — always available if enabled
    return true;
  },

  /**
   * Log configuration status
   */
  logStatus() {
    if (this.disabled) {
      logger.info('PDF-to-Markdown: DISABLED');
    } else if (this.provider === 'modal') {
      if (!this.modal.url) {
        logger.warn('PDF-to-Markdown: Modal provider selected but no URL configured (PDF_MARKDOWN_MODAL_API_URL)');
      } else {
        logger.info('PDF-to-Markdown: Modal/Docling configured', { url: this.modal.url });
      }
    } else {
      logger.info('PDF-to-Markdown: MarkItDown (local subprocess) configured');
    }
  }
};
