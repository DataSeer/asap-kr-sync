/**
 * Submissions Routes
 */

const express = require('express');
const submissionsController = require('../controllers/submissions.controller');
const krtController = require('../controllers/krt.controller');
const pdfController = require('../controllers/pdf.controller');
const reportsController = require('../controllers/reports.controller');
const jobsController = require('../controllers/jobs.controller');
const softwareController = require('../controllers/software.controller');
const orcidController = require('../controllers/orcid.controller');
const datasetsController = require('../controllers/datasets.controller');
const markdownController = require('../controllers/markdown.controller');
const materialsController = require('../controllers/materials.controller');
const protocolsController = require('../controllers/protocols.controller');
const identifierDetectionController = require('../controllers/identifier-detection.controller');
const suggestionController = require('../controllers/suggestion.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { canCreateSubmission, requireRole } = require('../middleware/role.middleware');
const { ROLES } = require('../config/constants');
const { canAccessSubmission, attachSubmissionFilter } = require('../middleware/team.middleware');
const { canViewJobInternals, canManageJobs } = require('../middleware/feature-access.middleware');
const { validateBody, validateQuery } = require('../middleware/validation.middleware');
const { uploadKRT, uploadPDF, handleMulterError } = require('../middleware/upload.middleware');
const { uploadLimiter, lmApiLimiter } = require('../middleware/rate-limit.middleware');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ===== Submission CRUD =====

// GET /api/submissions - List submissions (filtered by role)
router.get('/',
  attachSubmissionFilter,
  validateQuery('pagination'),
  submissionsController.list
);

// GET /api/submissions/hidden - List hidden submissions for current user
// NOTE: This must be before /:id routes to avoid matching 'hidden' as an ID
router.get('/hidden',
  attachSubmissionFilter,
  submissionsController.listHidden
);

// GET /api/submissions/filter-options - Get filter options (teams, users)
// NOTE: This must be before /:id routes to avoid matching 'filter-options' as an ID
router.get('/filter-options',
  attachSubmissionFilter,
  submissionsController.getFilterOptions
);

// POST /api/submissions - Create submission (author only).
// Multipart: metadata fields + required `krt` file. The controller
// validates the KRT format BEFORE any DB writes, so an invalid KRT
// returns 400 and leaves no orphan submission behind.
router.post('/',
  canCreateSubmission,
  uploadLimiter,
  uploadKRT.single('krt'),
  handleMulterError,
  validateBody('createSubmission'),
  submissionsController.create
);

// GET /api/submissions/:id - Get submission by ID
router.get('/:id',
  canAccessSubmission,
  submissionsController.getById
);

// PATCH /api/submissions/:id - Update submission
router.patch('/:id',
  canAccessSubmission,
  validateBody('updateSubmission'),
  submissionsController.update
);

// DELETE /api/submissions/:id - Delete submission (admin and ds_annotator only)
router.delete('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  submissionsController.delete
);

// POST /api/submissions/:id/new-round - Start a new round (process new version)
router.post('/:id/new-round',
  canAccessSubmission,
  validateBody('processNewVersion'),
  submissionsController.processNewVersion
);

// ===== Hide/Unhide Operations =====

// POST /api/submissions/:id/hide - Hide submission for current user
router.post('/:id/hide',
  submissionsController.hideSubmission
);

// POST /api/submissions/:id/unhide - Unhide submission for current user
router.post('/:id/unhide',
  submissionsController.unhideSubmission
);

// ===== File Operations =====

// GET /api/submissions/:id/files/:fileId/download - Download file (generates presigned URL)
router.get('/:id/files/:fileId/download',
  canAccessSubmission,
  submissionsController.downloadFile
);

// ===== KRT Operations =====

// POST /api/submissions/:id/krt/upload - Upload KRT file
router.post('/:id/krt/upload',
  canAccessSubmission,
  uploadLimiter,
  uploadKRT.single('file'),
  handleMulterError,
  krtController.upload
);

// GET /api/submissions/:id/krt - Get KRT data
router.get('/:id/krt',
  canAccessSubmission,
  krtController.getData
);

// PATCH /api/submissions/:id/krt/:rowId - Update KRT row
router.patch('/:id/krt/:rowId',
  canAccessSubmission,
  krtController.updateRow
);

// POST /api/submissions/:id/krt/row - Add KRT row
router.post('/:id/krt/row',
  canAccessSubmission,
  validateBody('krtRow'),
  krtController.addRow
);

// DELETE /api/submissions/:id/krt/:rowId - Delete KRT row
router.delete('/:id/krt/:rowId',
  canAccessSubmission,
  krtController.deleteRow
);

// POST /api/submissions/:id/krt/merge - Merge several rows into one
router.post('/:id/krt/merge',
  canAccessSubmission,
  krtController.mergeRows
);

// POST /api/submissions/:id/krt/validate - Re-validate KRT
router.post('/:id/krt/validate',
  canAccessSubmission,
  krtController.validate
);

// GET /api/submissions/:id/krt/download - Download corrected KRT
router.get('/:id/krt/download',
  canAccessSubmission,
  krtController.download
);

// ===== Supplemental Methods File =====

// POST /api/submissions/:id/supplemental/upload - Upload supplemental methods file (PDF or Word)
router.post('/:id/supplemental/upload',
  canAccessSubmission,
  uploadLimiter,
  uploadPDF.single('file'),
  handleMulterError,
  pdfController.uploadSupplemental
);

// ===== PDF Operations =====

// POST /api/submissions/:id/pdf/upload - Upload PDF
router.post('/:id/pdf/upload',
  canAccessSubmission,
  uploadLimiter,
  uploadPDF.single('file'),
  handleMulterError,
  pdfController.upload
);

// GET /api/submissions/:id/pdf/analysis - Get analysis status
router.get('/:id/pdf/analysis',
  canAccessSubmission,
  pdfController.getAnalysisStatus
);

// GET /api/submissions/:id/pdf/findings - Get LM findings
router.get('/:id/pdf/findings',
  canAccessSubmission,
  pdfController.getFindings
);

// POST /api/submissions/:id/pdf/analyze - Trigger analysis
router.post('/:id/pdf/analyze',
  canAccessSubmission,
  lmApiLimiter,
  pdfController.triggerAnalysis
);

// POST /api/submissions/:id/pdf/extract-das - Extract DAS from uploaded PDF
router.post('/:id/pdf/extract-das',
  canAccessSubmission,
  pdfController.extractDAS
);

// ===== Reports =====

// POST /api/submissions/:id/reports/generate - Generate report
router.post('/:id/reports/generate',
  canAccessSubmission,
  validateBody('generateReport'),
  reportsController.generate
);

// GET /api/submissions/:id/reports - Get reports
router.get('/:id/reports',
  canAccessSubmission,
  reportsController.list
);

// GET /api/submissions/:id/reports/:reportId - Get specific report
router.get('/:id/reports/:reportId',
  canAccessSubmission,
  reportsController.getById
);

// GET /api/submissions/:id/reports/:reportId/download - Download report (generates presigned URL)
router.get('/:id/reports/:reportId/download',
  canAccessSubmission,
  reportsController.download
);

// ===== Suggestions (unified across all sources) =====

// GET /api/submissions/:id/suggestions - Get all suggestions
router.get('/:id/suggestions',
  canAccessSubmission,
  suggestionController.getSuggestions
);

// POST /api/submissions/:id/suggestions/regenerate - Re-run the LM comparison job
router.post('/:id/suggestions/regenerate',
  canAccessSubmission,
  suggestionController.regenerateSuggestions
);

// POST /api/submissions/:id/suggestions/approve - Approve suggestion
router.post('/:id/suggestions/approve',
  canAccessSubmission,
  validateBody('approveSuggestion'),
  suggestionController.approveSuggestion
);

// POST /api/submissions/:id/suggestions/bulk-approve - Approve many in one call
router.post('/:id/suggestions/bulk-approve',
  canAccessSubmission,
  validateBody('bulkApproveSuggestions'),
  suggestionController.bulkApproveSuggestions
);

// POST /api/submissions/:id/suggestions/reject - Reject suggestion
router.post('/:id/suggestions/reject',
  canAccessSubmission,
  validateBody('rejectSuggestion'),
  suggestionController.rejectSuggestion
);

// POST /api/submissions/:id/suggestions/bulk-reject - Reject many in one call
router.post('/:id/suggestions/bulk-reject',
  canAccessSubmission,
  validateBody('bulkRejectSuggestions'),
  suggestionController.bulkRejectSuggestions
);

// ===== Software Detection =====

// GET /api/submissions/:id/software - Get software mentions
router.get('/:id/software',
  canAccessSubmission,
  softwareController.getSoftwareMentions
);

// POST /api/submissions/:id/software/detect - Trigger software detection
router.post('/:id/software/detect',
  canAccessSubmission,
  softwareController.triggerDetection
);

// ===== ORCID / Authors =====

// GET /api/submissions/:id/authors - Get authors with ORCIDs
router.get('/:id/authors',
  canAccessSubmission,
  orcidController.getAuthors
);

// POST /api/submissions/:id/authors/extract - Trigger ORCID extraction
router.post('/:id/authors/extract',
  canAccessSubmission,
  orcidController.triggerExtraction
);

// ===== Datasets Detection =====

// GET /api/submissions/:id/datasets - Get dataset mentions
router.get('/:id/datasets',
  canAccessSubmission,
  datasetsController.getDatasetMentions
);

// POST /api/submissions/:id/datasets/detect - Trigger datasets detection
router.post('/:id/datasets/detect',
  canAccessSubmission,
  datasetsController.triggerDetection
);

// ===== Markdown Convert =====

// POST /api/submissions/:id/markdown/convert - Trigger markdown conversion
router.post('/:id/markdown/convert',
  canAccessSubmission,
  markdownController.triggerConvert
);

// ===== Materials Detection =====

// GET /api/submissions/:id/materials - Get materials mentions
router.get('/:id/materials',
  canAccessSubmission,
  materialsController.getMaterialsMentions
);

// POST /api/submissions/:id/materials/detect - Trigger materials detection
router.post('/:id/materials/detect',
  canAccessSubmission,
  materialsController.triggerDetection
);

// ===== Protocols Detection =====

// GET /api/submissions/:id/protocols - Get protocols mentions
router.get('/:id/protocols',
  canAccessSubmission,
  protocolsController.getProtocolsMentions
);

// POST /api/submissions/:id/protocols/detect - Trigger protocols detection
router.post('/:id/protocols/detect',
  canAccessSubmission,
  protocolsController.triggerDetection
);

// ===== Identifier Detection =====

// GET /api/submissions/:id/identifiers - Get identifier-scan mentions
router.get('/:id/identifiers',
  canAccessSubmission,
  identifierDetectionController.getIdentifierMentions
);

// POST /api/submissions/:id/identifiers/detect - Trigger identifier detection
router.post('/:id/identifiers/detect',
  canAccessSubmission,
  identifierDetectionController.triggerDetection
);

// ===== Background Jobs =====

// GET /api/submissions/:id/jobs - Get background job statuses
router.get('/:id/jobs',
  canAccessSubmission,
  jobsController.getJobs
);

// POST /api/submissions/:id/processes/run - Run (or re-run) all background processes
router.post('/:id/processes/run',
  canAccessSubmission,
  jobsController.runProcesses
);

// POST /api/submissions/:id/jobs/:jobType/advance - Manually advance a pending_input job (staff only)
router.post('/:id/jobs/:jobType/advance',
  canAccessSubmission,
  canManageJobs,
  jobsController.advanceJob
);

// GET /api/submissions/:id/jobs/:jobType/responses/:responseName - Download raw response (hidden from authors)
router.get('/:id/jobs/:jobType/responses/:responseName',
  canAccessSubmission,
  canViewJobInternals,
  jobsController.getJobResponse
);

// ===== Change History =====

// GET /api/submissions/:id/changes - Get change log
router.get('/:id/changes',
  canAccessSubmission,
  submissionsController.getChanges
);

module.exports = router;
