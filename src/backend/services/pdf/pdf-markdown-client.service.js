/**
 * PDF-to-Markdown Client Service
 *
 * Converts PDF files to Markdown text using either:
 * - MarkItDown (local subprocess via Python package)
 * - Modal API with Docling (remote)
 *
 * Provider is selected via PDF_MARKDOWN_PROVIDER env var.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const markdownConfig = require('../../config/pdf-markdown-api');
const { ExternalServiceError } = require('../../utils/errors');
const { retry, isTransientError } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * Convert a PDF buffer to Markdown text.
 *
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {string} fileName - Original file name (for logging and multipart field)
 * @returns {Promise<string>} Markdown text
 */
async function convertToMarkdown(pdfBuffer, fileName) {
  const provider = markdownConfig.provider;

  if (provider === 'modal') {
    return convertViaModal(pdfBuffer, fileName);
  }

  return convertViaMarkItDown(pdfBuffer, fileName);
}

/**
 * Convert PDF to Markdown via the MarkItDown Python package (subprocess).
 * Writes the PDF to a temp file, runs `markitdown <file>`, and captures stdout.
 *
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @returns {Promise<string>}
 */
async function convertViaMarkItDown(pdfBuffer, fileName) {
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const timeout = markdownConfig.timeout || 120000;

  logger.info('Converting PDF to Markdown via MarkItDown (subprocess)', { fileName });

  // Write PDF to a per-call temp directory with a randomized, attacker-free
  // filename. Earlier code used `path.join(os.tmpdir(), `…-${fileName}`)`
  // which let `fileName` contain `../` segments and escape `os.tmpdir()` —
  // markitdown would then read whatever path the upload's `originalname`
  // resolved to. We now generate the filename internally and use the
  // user-supplied name only in log messages.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'asap-markdown-'));
  const tmpFile = path.join(tmpDir, `${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(tmpFile, pdfBuffer);

  try {
    const markdown = await new Promise((resolve, reject) => {
      execFile(pythonBin, ['-m', 'markitdown', tmpFile], { timeout, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          logger.error('MarkItDown subprocess failed', { fileName, error: error.message, stderr });
          return reject(new ExternalServiceError('MarkItDown', error.message));
        }
        resolve(stdout);
      });
    });

    if (!markdown || markdown.trim().length === 0) {
      throw new ExternalServiceError('MarkItDown', 'Returned empty output');
    }

    logger.info('MarkItDown conversion successful', {
      fileName,
      markdownLength: markdown.length
    });

    return markdown;
  } finally {
    // Clean up the per-call temp dir + file. unlink first, then rmdir.
    try { fs.unlinkSync(tmpFile); } catch (err) { logger.debug('tmpFile unlink failed', { err: err.message }); }
    try { fs.rmdirSync(tmpDir); } catch (err) { logger.debug('tmpDir rmdir failed', { err: err.message }); }
  }
}

/**
 * Convert PDF to Markdown via Modal API (Docling).
 * POST multipart/form-data with fields "article" (PDF) and "data" (JSON config).
 * Expects response: { success: true, converter: "docling", markdown: "...", length: N }
 *
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @returns {Promise<string>}
 */
async function convertViaModal(pdfBuffer, fileName) {
  const url = markdownConfig.modal.url;
  const converter = markdownConfig.modal.converter;

  if (!url) {
    throw new ExternalServiceError('Modal', 'Modal API URL not configured (PDF_MARKDOWN_MODAL_API_URL)');
  }

  logger.info('Converting PDF to Markdown via Modal/Docling', { fileName, url, converter });

  const form = new FormData();
  form.append('article', pdfBuffer, {
    filename: fileName,
    contentType: 'application/pdf'
  });
  form.append('data', JSON.stringify({ converter }));

  const headers = { ...form.getHeaders() };
  if (markdownConfig.modal.apiKey) {
    headers['Authorization'] = `Bearer ${markdownConfig.modal.apiKey}`;
  }

  try {
    // Docling conversion is slow and the Modal endpoint can cold-start or briefly
    // 503/time out; retry transient failures with backoff before giving up so a
    // single blip doesn't fail the whole document. Deterministic errors (4xx,
    // unexpected body) fall through immediately.
    const response = await retry(() => axios.post(url, form, {
      headers,
      timeout: markdownConfig.timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }), {
      maxRetries: 3, delay: 2000, multiplier: 2, maxDelay: 20000, jitter: 500,
      shouldRetry: isTransientError,
      onRetry: (attempt, waitMs, error) =>
        logger.warn('Modal/Docling transient error, retrying', { fileName, attempt, nextRetryMs: waitMs, error: error.message })
    });

    const data = response.data;

    if (!data?.success || typeof data.markdown !== 'string') {
      throw new Error(`Modal API returned unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    logger.info('Modal/Docling conversion successful', {
      fileName,
      converter: data.converter,
      markdownLength: data.length || data.markdown.length
    });

    return data.markdown;
  } catch (error) {
    if (error.response) {
      logger.error('Modal API error', {
        fileName,
        status: error.response.status,
        data: error.response.data
      });
    } else {
      logger.error('Modal request failed', {
        fileName,
        error: error.message
      });
    }
    throw new ExternalServiceError('Modal/Docling', error.message);
  }
}

module.exports = {
  convertToMarkdown
};
