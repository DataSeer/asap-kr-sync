/**
 * Helper Utility Functions
 */

const { getTeams } = require('../config/constants');

/**
 * Extract team code from manuscript ID
 * @param {string} manuscriptId - e.g., "XX1-000000-001-org-X-1"
 * @returns {Promise<string|null>} - Team code (e.g., "RE") or null if invalid
 */
async function extractTeamFromManuscriptId(manuscriptId) {
  if (!manuscriptId || typeof manuscriptId !== 'string') {
    return null;
  }

  // Extract first 2 characters
  const teamCode = manuscriptId.substring(0, 2).toUpperCase();

  // Validate against known teams from database
  const teams = await getTeams();
  if (teams.includes(teamCode)) {
    return teamCode;
  }

  return null;
}

/**
 * Sanitize filename for safe storage in S3
 * Preserves the original name as much as possible while removing unsafe characters
 * @param {string} filename
 * @returns {string} Sanitized filename (without extension)
 */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'file';
  }

  // Remove extension first (we'll add it back later)
  const lastDotIndex = filename.lastIndexOf('.');
  const nameWithoutExt = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;

  return nameWithoutExt
    // Replace spaces with underscores
    .replace(/\s+/g, '_')
    // Remove or replace unsafe characters for S3/URLs
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    // Replace multiple underscores/hyphens with single one
    .replace(/[_-]+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    // Limit length (S3 keys have a 1024 byte limit, but let's be conservative)
    .substring(0, 100)
    // Fallback if empty after sanitization
    || 'file';
}

/**
 * Build the S3 folder name for a submission.
 * Format: {manuscriptId}_{submissionId} (or just submissionId if no manuscript ID)
 * This ensures uniqueness (UUID) while remaining human-browsable (manuscript ID prefix).
 *
 * @param {string|null} manuscriptId
 * @param {string} submissionId - UUID
 * @returns {string}
 */
function buildS3Folder(manuscriptId, submissionId) {
  if (manuscriptId) {
    return `${manuscriptId}_${submissionId}`;
  }
  return submissionId;
}

/**
 * Generate a unique S3 key for file storage.
 * Structure: {manuscriptId}_{submissionId}/round-{round}/{fileType}/{sanitizedName}_v{version}.{ext}
 *
 * @param {string} manuscriptId - Manuscript ID (can be null)
 * @param {string} submissionId - Submission UUID (guarantees uniqueness)
 * @param {number} round - Submission round number
 * @param {string} fileType - File type (krt, pdf, markdown, etc.)
 * @param {string} originalName - Original file name
 * @param {number} version - File version
 * @returns {string} S3 key (without bucket prefix — that's added by s3Service)
 */
function generateS3Key(manuscriptId, submissionId, round, fileType, originalName, version = 1) {
  const folder = buildS3Folder(manuscriptId, submissionId);
  const sanitizedName = sanitizeFilename(originalName);
  const extension = originalName.split('.').pop().toLowerCase();
  return `${folder}/round-${round}/${fileType}/${sanitizedName}_v${version}.${extension}`;
}

/**
 * Generate an S3 key for job log/response files.
 * Structure: {manuscriptId}_{submissionId}/round-{round}/jobs/{jobType}/{fileName}
 *
 * @param {string} manuscriptId - Manuscript ID (can be null)
 * @param {string} submissionId - Submission UUID
 * @param {number} round - Submission round number
 * @param {string} jobType - Job type (e.g., "datasets_detection")
 * @param {string} fileName - File name (e.g., "logs.json", "gemini-consolidation.json")
 * @returns {string} S3 key (without bucket prefix)
 */
function generateJobS3Key(manuscriptId, submissionId, round, jobType, fileName) {
  const folder = buildS3Folder(manuscriptId, submissionId);
  return `${folder}/round-${round}/jobs/${jobType}/${fileName}`;
}

/**
 * Normalize column name for KRT data
 * @param {string} columnName
 * @returns {string} Normalized column name
 */
function normalizeColumnName(columnName) {
  return columnName
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Sanitize string for safe storage
 * @param {string} str
 * @returns {string} Sanitized string
 */
function sanitizeString(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Remove control characters
}

/**
 * Parse pagination parameters
 * @param {object} query - Express query object
 * @param {object} defaults - Default values
 * @returns {object} { page, limit, offset }
 */
function parsePagination(query, defaults = { page: 1, limit: 20 }) {
  const page = Math.max(1, parseInt(query.page, 10) || defaults.page);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defaults.limit));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Build pagination response metadata
 * @param {number} total - Total count
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @returns {object} Pagination metadata
 */
function buildPaginationMeta(total, page, limit) {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1
  };
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {object} options - Retry options
 * @returns {Promise<any>}
 */
async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    delay = 1000,
    multiplier = 2,
    onRetry = () => {}
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const waitTime = delay * Math.pow(multiplier, attempt - 1);
        onRetry(attempt, waitTime, error);
        await sleep(waitTime);
      }
    }
  }
  throw lastError;
}

/**
 * Derive the step number from a submission status
 * @param {string} status - Submission status
 * @returns {number} Step number (1-5)
 */
function statusToStep(status) {
  const map = {
    draft: 1, step_krt: 1, step_pdf: 2, step_review: 3,
    step_as: 4, step_report: 5, completed: 5
  };
  return map[status] || 1;
}

/**
 * Build a human-friendly download filename for a generated report.
 * Prefers the manuscript ID; falls back to the uploaded PDF's filename (sans
 * extension); finally 'report'. Hyphens are preserved (so a manuscript ID like
 * "WH1-000282-012-org-t-2" stays recognisable), unlike sanitizeFilename which
 * collapses them for S3 keys.
 *
 * @param {string|null} manuscriptId
 * @param {string|null} pdfFileName - original PDF filename (may include extension)
 * @param {string} [ext='xlsx']
 * @returns {string} e.g. "WH1-000282-012-org-t-2.xlsx"
 */
function buildReportFilename(manuscriptId, pdfFileName, ext = 'xlsx') {
  let base = (manuscriptId && String(manuscriptId).trim()) || '';
  if (!base && pdfFileName) {
    const name = String(pdfFileName);
    const dot = name.lastIndexOf('.');
    base = dot > 0 ? name.slice(0, dot) : name;
  }
  base = base
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '')   // keep alnum, dot, underscore, hyphen
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 100);
  if (!base) base = 'report';
  return `${base}.${ext}`;
}

module.exports = {
  extractTeamFromManuscriptId,
  statusToStep,
  sanitizeFilename,
  buildReportFilename,
  buildS3Folder,
  generateS3Key,
  generateJobS3Key,
  normalizeColumnName,
  sanitizeString,
  parsePagination,
  buildPaginationMeta,
  sleep,
  retry
};
