/**
 * Job Logger Service
 *
 * Provides structured logging and raw response caching for background jobs.
 * Each job gets a logger instance that:
 *   - Collects structured log entries (stored in SubmissionJob.logs JSONB)
 *   - Uploads raw API responses to S3 (stored as S3 keys in SubmissionJob.rawResponses)
 *   - Flushes everything to DB on complete/fail
 *
 * Usage in workers:
 *   const jobLogger = createJobLogger(submissionJob, manuscriptId, round);
 *   jobLogger.log('step_name', 'Human-readable message', { key: 'value' });
 *   await jobLogger.saveRawResponse('gemini-consolidation', jsonData);
 *   await jobLogger.flush();
 */

const s3Service = require('../storage/s3.service');
const { generateJobS3Key } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * Create a job logger for a background job.
 *
 * @param {object} submissionJob - The SubmissionJob model instance
 * @param {string} manuscriptId - Manuscript ID for S3 key generation
 * @param {number} round - Submission round
 * @returns {object} Logger with log(), saveRawResponse(), flush()
 */
function createJobLogger(submissionJob, manuscriptId, round) {
  const entries = [];
  const rawResponses = {};
  const jobType = submissionJob.jobType;

  return {
    /**
     * Add a structured log entry.
     *
     * @param {string} step - Step identifier (e.g., "download_pdf", "extract_signals")
     * @param {string} message - Human-readable description
     * @param {object} [data] - Optional structured data (counts, durations, etc.)
     */
    log(step, message, data = null) {
      const entry = {
        ts: new Date().toISOString(),
        step,
        message,
        ...(data ? { data } : {})
      };
      entries.push(entry);

      // Also log to Winston for server-side debugging
      logger.info(`[${jobType}] ${message}`, {
        submissionId: submissionJob.submissionId,
        step,
        ...( data || {})
      });
    },

    /**
     * Upload a raw API response to S3 and track the S3 key.
     *
     * @param {string} name - Response identifier (e.g., "gemini-consolidation", "softcite-response")
     * @param {object|string} data - The response data (will be JSON-stringified if object)
     * @param {object} [options] - Optional settings
     * @param {string} [options.extension='.json'] - File extension (e.g., '.md', '.json')
     * @param {string} [options.mimeType='application/json'] - MIME type for S3 upload
     */
    async saveRawResponse(name, data, options = {}) {
      const ext = options.extension || '.json';
      const mime = options.mimeType || 'application/json';
      const fileName = `${name}${ext}`;
      const s3Key = generateJobS3Key(manuscriptId, submissionJob.submissionId, round, jobType, fileName);
      const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

      try {
        await s3Service.uploadFile(s3Key, Buffer.from(content, 'utf-8'), mime);
        rawResponses[name] = s3Key;

        logger.debug(`[${jobType}] Raw response saved to S3`, {
          submissionId: submissionJob.submissionId,
          name,
          s3Key,
          size: content.length
        });
      } catch (error) {
        // Non-critical — log the failure but don't break the job
        logger.warn(`[${jobType}] Failed to save raw response to S3`, {
          submissionId: submissionJob.submissionId,
          name,
          error: error.message
        });
      }
    },

    /**
     * Flush all collected logs and raw response references to the database.
     * Call this once at the end of the job (on complete or fail).
     */
    async flush() {
      try {
        // Reload to pick up result changes from markComplete or service writes
        await submissionJob.reload();
        submissionJob.logs = entries;
        // Store raw response S3 keys in result.files
        if (Object.keys(rawResponses).length > 0) {
          submissionJob.result = { ...(submissionJob.result || {}), files: { ...(submissionJob.result?.files || {}), ...rawResponses } };
          submissionJob.changed('result', true);
        }
        submissionJob.changed('logs', true);
        await submissionJob.save();
      } catch (error) {
        logger.error(`[${jobType}] Failed to flush job logs to DB`, {
          submissionId: submissionJob.submissionId,
          error: error.message
        });
      }
    },

    /** Get current log entries (for inspection) */
    getEntries() { return entries; },

    /** Get current raw response map (for inspection) */
    getRawResponses() { return rawResponses; }
  };
}

module.exports = { createJobLogger };
