/**
 * PDF DAS Extractor Client Service
 *
 * Calls the Modal-hosted section-extraction endpoint to copy a single
 * section's text out of an article verbatim. Default section is `das`
 * (Data Availability Statement); the section + converter come from
 * pdf-das-extractor-api config so they're tunable per environment.
 *
 * Request: POST multipart/form-data
 *   article    — the PDF file
 *   section    — e.g. 'das' (set in config)
 *   converter  — 'markitdown' (default) or 'docling' (higher recall)
 *   Headers:   X-API-Key
 *
 * Response: the endpoint's docs aren't explicit on the JSON shape; we
 * accept any of the common conventions (plain text body, or JSON with
 * `text` / `extracted_text` / `section_text` / `extracted_das` / `content`
 * keys) so this client doesn't break if the shape evolves slightly. The
 * actual shape on first successful response gets logged at DEBUG level
 * for quick verification.
 *
 * Status-code semantics (per endpoint docs):
 *   400 — unknown `section` value (deploy bug, not transient).
 *   502 — conversion or inference failure (transient, retry-eligible).
 */

const axios = require('axios');
const FormData = require('form-data');
const dasExtractorConfig = require('../../config/pdf-das-extractor-api');
const { ExternalServiceError } = require('../../utils/errors');
const { retry } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * Pull the extracted section text out of whatever shape the endpoint
 * returned. Returns '' if nothing recognisable is present (caller decides
 * whether that's an error condition).
 *
 * @param {*} data - axios response.data
 * @returns {string}
 */
function pickExtractedText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return '';

  // Try the most likely keys in order. First non-empty string wins.
  const candidates = [
    'text',
    'extracted_text',
    'extracted_das',
    'section_text',
    'content',
    'result'
  ];
  for (const key of candidates) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  // Nested under e.g. { section: { text: '…' } } or { das: '…' }
  const sectionKey = dasExtractorConfig.section;
  if (sectionKey) {
    const v = data[sectionKey];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  }
  return '';
}

/**
 * Extract the configured section from a PDF buffer.
 * @param {Buffer} pdfBuffer
 * @param {string} fileName - Original file name (form data label)
 * @returns {Promise<string>} Extracted section text (may be empty string)
 */
async function extractDAS(pdfBuffer, fileName = 'article.pdf') {
  if (!dasExtractorConfig.isConfigured()) {
    logger.warn('DAS Extractor not configured, skipping');
    return null;
  }

  try {
    const responseData = await retry(
      async () => {
        const form = new FormData();
        form.append('article', pdfBuffer, {
          filename: fileName,
          contentType: 'application/pdf'
        });
        form.append('section', dasExtractorConfig.section);
        form.append('converter', dasExtractorConfig.converter);

        const response = await axios.post(dasExtractorConfig.baseUrl, form, {
          headers: {
            ...form.getHeaders(),
            'X-API-Key': dasExtractorConfig.apiKey
          },
          timeout: dasExtractorConfig.timeout,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });
        return response.data;
      },
      {
        maxRetries: dasExtractorConfig.retryConfig.maxRetries,
        delay: dasExtractorConfig.retryConfig.retryDelay,
        multiplier: dasExtractorConfig.retryConfig.retryDelayMultiplier,
        onRetry: (attempt, waitTime, error) => {
          logger.warn(`DAS Extractor API retry attempt ${attempt}`, {
            waitTime,
            error: error.message
          });
        }
      }
    );

    const extractedDas = pickExtractedText(responseData);

    // Log the raw response shape once per call (DEBUG only) so we can confirm
    // pickExtractedText hit the right key without flooding logs in prod.
    logger.debug('DAS extraction response shape', {
      type: typeof responseData,
      keys: responseData && typeof responseData === 'object' ? Object.keys(responseData) : null,
      length: extractedDas.length
    });

    logger.info('DAS extraction completed', {
      section: dasExtractorConfig.section,
      converter: dasExtractorConfig.converter,
      hasResult: !!extractedDas,
      length: extractedDas.length
    });

    return extractedDas;
  } catch (error) {
    logger.error('DAS Extractor API error', { error: error.message });

    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error || error.response.data?.detail || error.message;

      if (status === 400) {
        // Unknown section value — deploy bug. Surface the message so the
        // operator knows what to fix in env config.
        throw new ExternalServiceError(
          'DAS Extractor',
          `Bad request from extractor (likely unknown section="${dasExtractorConfig.section}"): ${message}`
        );
      }
      if (status === 401) {
        throw new ExternalServiceError('DAS Extractor', 'Authentication failed');
      }
      if (status === 429) {
        throw new ExternalServiceError('DAS Extractor', 'Rate limit exceeded');
      }
      if (status === 502) {
        // Conversion or inference failed — treat as transient service error
        // so demo-fallback / pg-boss retries kick in.
        throw new ExternalServiceError('DAS Extractor', 'Conversion or inference failed (502)');
      }
      if (status >= 500) {
        throw new ExternalServiceError('DAS Extractor', 'Service unavailable');
      }

      throw new ExternalServiceError('DAS Extractor', message);
    }

    if (error.code === 'ECONNABORTED') {
      throw new ExternalServiceError('DAS Extractor', 'Request timeout');
    }

    throw new ExternalServiceError('DAS Extractor', error.message);
  }
}

module.exports = {
  extractDAS,
  // exposed for tests
  pickExtractedText
};
