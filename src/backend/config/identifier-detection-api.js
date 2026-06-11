/**
 * Identifier Detection Configuration
 *
 * Identifier detection is a pure local scan of the converted markdown (no
 * external API, no key). These two flags let an operator turn the module off
 * or toggle the "References" cutoff that truncates the scan at the bibliography.
 */

const logger = require('../utils/logger');

module.exports = {
  // Enable/disable the module. Defaults to ENABLED (the historic behaviour);
  // set IDENTIFIER_DETECTION_ENABLED=false to skip identifier detection (the
  // job then produces no data, like any module turned Off).
  isEnabled() {
    return process.env.IDENTIFIER_DETECTION_ENABLED !== 'false';
  },

  // Truncate the document at the first "References"/"Bibliography" heading
  // before scanning (so cited-paper DOIs in the bibliography don't create false
  // positives). Defaults to ON. Set IDENTIFIER_DETECTION_CUT_AT_REFERENCES=false
  // to scan the WHOLE document — needed for combined manuscript+supplemental
  // PDFs where the Key Resources table sits AFTER the references heading (see
  // docs/background-modules.md §3.7 / KNOWN_ISSUES.md).
  cutAtReferences() {
    return process.env.IDENTIFIER_DETECTION_CUT_AT_REFERENCES !== 'false';
  },

  logStatus() {
    logger.info(
      `Identifier Detection: ${this.isEnabled() ? 'ENABLED' : 'DISABLED'} ` +
      `(references cutoff ${this.cutAtReferences() ? 'on' : 'off'})`
    );
  }
};
