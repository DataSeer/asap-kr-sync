/**
 * Softcite API Client Service
 *
 * Calls the software-mentions service to detect code/software mentions in PDFs.
 * API expects: POST multipart/form-data with field "input" (PDF file)
 * API returns: JSON with mentions array containing software-name, version, url, etc.
 */

const axios = require('axios');
const FormData = require('form-data');
const softciteConfig = require('../../config/softcite-api');
const { ExternalServiceError } = require('../../utils/errors');
const { retry } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * Parse the Softcite JSON response into a normalized list of mentions.
 * @param {object} raw - Raw JSON response from Softcite
 * @returns {Array<object>} Normalized mentions
 */
function parseMentions(raw) {
  const mentions = raw.mentions
    || raw['software-mentions']
    || (Array.isArray(raw) ? raw : []);

  return mentions.map(m => {
    const name = m['software-name']?.rawForm
      || m['software-name']?.normalizedForm
      || m.softwareName?.rawForm
      || m.rawForm
      || 'unknown';

    return {
      name,
      normalizedName: m['software-name']?.normalizedForm || name,
      version: m['version-number']?.rawForm || m['version-date']?.rawForm || null,
      url: m.url?.rawForm || null,
      creator: m.creator?.rawForm || null,
      type: m.type || null,
      confidence: m['software-name']?.confidence ?? m.confidence ?? null,
      context: m.context || null,
      offsetStart: m['software-name']?.offsetStart ?? null,
      offsetEnd: m['software-name']?.offsetEnd ?? null
    };
  });
}

/**
 * Send a PDF buffer to Softcite for software mention detection
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} fileName - Original file name
 * @returns {Promise<{ mentions: Array, raw: object, durationMs: number }>}
 */
async function detectSoftware(pdfBuffer, fileName = 'article.pdf') {
  if (!softciteConfig.isConfigured()) {
    logger.warn('Softcite API not configured, skipping software detection');
    return { mentions: [], raw: null, durationMs: 0 };
  }

  const start = Date.now();

  try {
    const result = await retry(
      async () => {
        const form = new FormData();
        form.append('input', pdfBuffer, {
          filename: fileName,
          contentType: 'application/pdf'
        });

        const response = await axios.post(
          `${softciteConfig.baseUrl}/service/annotateSoftwarePDF`,
          form,
          {
            headers: form.getHeaders(),
            timeout: softciteConfig.timeout,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        );

        return response.data;
      },
      {
        maxRetries: softciteConfig.retryConfig.maxRetries,
        delay: softciteConfig.retryConfig.retryDelay,
        multiplier: softciteConfig.retryConfig.retryDelayMultiplier,
        onRetry: (attempt, waitTime, error) => {
          logger.warn(`Softcite API retry attempt ${attempt}`, {
            waitTime,
            error: error.message
          });
        }
      }
    );

    const durationMs = Date.now() - start;
    const mentions = parseMentions(result);

    logger.info('Softcite detection completed', {
      mentionCount: mentions.length,
      durationMs
    });

    return { mentions, raw: result, durationMs };
  } catch (error) {
    logger.error('Softcite API error', { error: error.message });

    if (error.response) {
      const status = error.response.status;
      if (status === 503) {
        throw new ExternalServiceError('Softcite', 'Service unavailable (model may still be loading)');
      }
      if (status >= 500) {
        throw new ExternalServiceError('Softcite', 'Service error');
      }
      throw new ExternalServiceError('Softcite', `HTTP ${status}`);
    }

    if (error.code === 'ECONNABORTED') {
      throw new ExternalServiceError('Softcite', 'Request timeout');
    }

    throw new ExternalServiceError('Softcite', error.message);
  }
}

module.exports = {
  detectSoftware,
  parseMentions
};
