/**
 * PDF-to-Markdown API Configuration
 *
 * Supports two providers:
 * - "markitdown" (default): Local MarkItDown Docker container
 * - "modal": Remote Modal API endpoint using Docling
 */

const logger = require('../utils/logger');

module.exports = {
  // Provider: "markitdown" (local Docker) or "modal" (remote API)
  provider: process.env.PDF_MARKDOWN_PROVIDER || 'modal',

  // MarkItDown configuration (local Docker container)
  markitdown: {
    url: process.env.PDF_MARKDOWN_MARKITDOWN_URL || 'http://markitdown:3001',
    endpoint: process.env.PDF_MARKDOWN_MARKITDOWN_ENDPOINT || '/convert'
  },

  // Modal/Docling configuration (remote API)
  modal: {
    url: process.env.PDF_MARKDOWN_MODAL_API_URL || '',
    apiKey: process.env.PDF_MARKDOWN_MODAL_API_KEY || '',
    converter: process.env.PDF_MARKDOWN_MODAL_CONVERTER || 'docling'
  },

  // Request timeout (2 minutes — PDF conversion can be slow for large documents)
  timeout: parseInt(process.env.PDF_MARKDOWN_TIMEOUT, 10) || 120000,

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
      logger.info('PDF-to-Markdown: MarkItDown configured', { url: this.markitdown.url });
    }
  }
};
