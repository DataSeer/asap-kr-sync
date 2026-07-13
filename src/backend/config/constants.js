/**
 * Application Constants
 */

const path = require('path');

// Load rate limits from conf/ directory (defaults), overridable per bucket
// via env so ops can tune limits without a redeploy:
//   RATE_LIMIT_<BUCKET>_MAX / RATE_LIMIT_<BUCKET>_WINDOW_MS
// where <BUCKET> is the upper-cased key: API, AUTH, REFRESH, UPLOAD, LMAPI.
// Invalid (non-numeric/non-positive) values fall back to the conf default.
const rateLimitDefaults = require('../../../conf/rate-limits.json');

function envOverride(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return parsed > 0 ? parsed : fallback;
}

const rateLimits = Object.fromEntries(
  Object.entries(rateLimitDefaults).map(([bucket, cfg]) => {
    const key = bucket.toUpperCase();
    return [bucket, {
      ...cfg,
      max: envOverride(`RATE_LIMIT_${key}_MAX`, cfg.max),
      windowMs: envOverride(`RATE_LIMIT_${key}_WINDOW_MS`, cfg.windowMs)
    }];
  })
);

// Lazy-load config service to avoid circular dependencies
// (config.service.js -> models -> User.js -> constants.js)
let _configService = null;
function getConfigService() {
  if (!_configService) {
    _configService = require('../services/config.service');
  }
  return _configService;
}

module.exports = {
  // User roles
  ROLES: {
    AUTHOR: 'author',
    ASAP_PM: 'asap_pm',
    DS_ANNOTATOR: 'ds_annotator',
    ADMIN: 'admin'
  },

  // Async getters for dynamic configuration from database
  getTeams: () => getConfigService().getTeams(),
  getProjects: () => getConfigService().getProjects(),
  getResourceTypes: () => getConfigService().getResourceTypes(),
  getValidationRules: () => getConfigService().getValidationRules(),

  // Invalidate config cache when data changes
  invalidateConfigCache: () => getConfigService().invalidateCache(),

  // Submission statuses (step-based for clear navigation)
  SUBMISSION_STATUSES: [
    'draft',        // Initial state
    'step_krt',     // Working on KRT upload/validation
    'step_pdf',     // Working on PDF upload/analysis
    'step_review',  // Reviewing changes
    'step_as',      // Availability Statement review
    'step_report',  // Generating reports
    'completed'     // Finished
  ],

  // File types
  FILE_TYPES: {
    KRT: 'krt',
    PDF: 'pdf',
    PDF_ORIGINAL: 'pdf_original',
    SUPPLEMENTAL: 'supplemental',
    SUPPLEMENTAL_PDF: 'supplemental_pdf',
    REPORT: 'report',
    MARKDOWN: 'markdown'
  },

  // Report types
  REPORT_TYPES: {
    EXCEL: 'excel',
    PDF: 'pdf'
  },

  // KRT columns (in order)
  KRT_COLUMNS: [
    'RESOURCE TYPE',
    'RESOURCE NAME',
    'SOURCE',
    'IDENTIFIER',
    'NEW/REUSE',
    'ADDITIONAL INFORMATION'
  ],

  // Change log actions
  CHANGE_ACTIONS: [
    'upload',
    'edit',
    'add_row',
    'delete_row',
    'approve_change',
    'reject_change',
    'import_findings',
    'new_round'
  ],

  // Change log sources (what triggered the change)
  CHANGE_SOURCES: [
    'manual',           // User manually edited the value
    'ai_suggestion',    // User accepted an AI/LM suggestion
    'krt_validation'    // User accepted a KRT validation fix
  ],

  // Job types for the unified SubmissionJob tracking system
  JOB_TYPES: {
    DAS_EXTRACTION: 'das_extraction',
    PDF_ANALYSIS: 'pdf_analysis',
    REPORT_GENERATION: 'report_generation',
    SOFTWARE_DETECTION: 'software_detection',
    ORCID_EXTRACTION: 'orcid_extraction',
    DATASETS_DETECTION: 'datasets_detection',
    MARKDOWN_CONVERT: 'markdown_convert',
    MATERIALS_DETECTION: 'materials_detection',
    PROTOCOLS_DETECTION: 'protocols_detection',
    IDENTIFIER_DETECTION: 'identifier_detection',
    // LM-based comparison of the author KRT vs the Generated KRT that produces
    // the add/update/remove suggestions (runs after PDF_ANALYSIS; re-triggerable).
    SUGGESTION_GENERATION: 'suggestion_generation'
  },

  // Job statuses (matches SubmissionJob ENUM)
  JOB_STATUSES: [
    'waiting',
    'pending_input',
    'queued',
    'processing',
    'complete',
    'failed'
  ],

  // Validation severity levels
  VALIDATION_SEVERITY: {
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info'
  },

  // Dynamic resource type group ordering (loaded from DB via config.service)
  getResourceTypeGroupOrder: () => getConfigService().getResourceTypeGroupOrder(),
  getResourceTypeSortOrder: () => getConfigService().getResourceTypeSortOrder(),

  // Supported file formats
  SUPPORTED_KRT_FORMATS: ['.csv', '.xlsx'],
  SUPPORTED_PDF_FORMAT: '.pdf',
  SUPPORTED_DOCUMENT_FORMATS: ['.pdf', '.doc', '.docx'],

  // Maximum file sizes (in bytes)
  MAX_FILE_SIZES: {
    KRT: 10 * 1024 * 1024,    // 10MB
    PDF: 50 * 1024 * 1024     // 50MB
  },

  // KRT Template URL (Google Sheets)
  KRT_TEMPLATE_URL: process.env.KRT_TEMPLATE_URL || '',

  // Rate limiting configuration
  RATE_LIMITS: rateLimits
};
