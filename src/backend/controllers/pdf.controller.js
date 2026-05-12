/**
 * PDF Controller
 */

const pdfService = require('../services/pdf/pdf.service');
const orchestrator = require('../services/queue/orchestrator.service');
const { SubmissionJob, ChangeLog, Submission } = require('../models');
const suggestionService = require('../services/suggestion/suggestion.service');
const { JOB_TYPES } = require('../config/constants');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Upload PDF
 * POST /api/submissions/:id/pdf/upload
 */
async function upload(req, res, next) {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    // Magic-byte check: reject anything that isn't a real PDF or DOCX (ZIP).
    // Guards against HTML/error pages being POSTed as a "PDF" (e.g. when the
    // frontend fetches a missing demo file and a fallback returns index.html).
    const buf = req.file.buffer;
    const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
    const isDocx = buf.length >= 4
      && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    if (!isPdf && !isDocx) {
      throw new ValidationError('Uploaded file is not a valid PDF or DOCX');
    }

    const submission = req.submission;
    const result = await pdfService.uploadPDF(
      submission.id,
      req.file,
      req.userId,
      submission.currentRound
    );

    // Status is now step-based and only changes on navigation
    // PDF upload state is tracked via the File records

    logger.info('PDF uploaded', { submissionId: submission.id });

    // Start the full processing pipeline (DAS → PDF analysis, Software detection in parallel)
    await orchestrator.runAllProcesses(submission.id, req.userId, submission.currentRound);

    res.json({
      message: 'PDF uploaded successfully',
      file: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Upload supplemental methods file
 * POST /api/submissions/:id/supplemental/upload
 */
async function uploadSupplemental(req, res, next) {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    const submission = req.submission;
    const result = await pdfService.uploadSupplemental(
      submission.id,
      req.file,
      req.userId,
      submission.currentRound
    );

    logger.info('Supplemental file uploaded', { submissionId: submission.id });

    res.json({
      message: 'Supplemental file uploaded successfully',
      file: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Extract DAS from uploaded PDF
 * POST /api/submissions/:id/pdf/extract-das
 */
async function extractDAS(req, res, next) {
  try {
    const submission = req.submission;
    const result = await pdfService.extractAndSaveDAS(submission.id);

    res.json({
      message: result.extracted
        ? 'Availability Statement extracted successfully'
        : 'Availability Statement not found',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get analysis status
 * GET /api/submissions/:id/pdf/analysis
 */
async function getAnalysisStatus(req, res, next) {
  try {
    const job = await SubmissionJob.getLatest(req.params.id, JOB_TYPES.PDF_ANALYSIS, req.submission.currentRound);

    if (!job) {
      return res.json({
        status: 'not_started',
        message: 'No analysis has been started'
      });
    }

    res.json({
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get LM findings
 * GET /api/submissions/:id/pdf/findings
 */
async function getFindings(req, res, next) {
  try {
    const job = await SubmissionJob.getLatest(req.params.id, JOB_TYPES.PDF_ANALYSIS, req.submission.currentRound);

    if (!job) {
      throw new NotFoundError('Analysis');
    }

    if (job.status !== 'complete') {
      return res.json({
        status: job.status,
        findings: [],
        message: 'Analysis not yet complete'
      });
    }

    // Suggestions are now derived as the diff between the Generated KRT
    // (this job's result) and the user's KRT, filtered by rejections.
    const { suggestions } = await suggestionService.getAllSuggestions(
      req.params.id,
      req.submission.currentRound
    );

    res.json({
      status: job.status,
      findings: suggestions,
      completedAt: job.completedAt
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger analysis
 * POST /api/submissions/:id/pdf/analyze
 */
async function triggerAnalysis(req, res, next) {
  try {
    const submission = req.submission;

    // Allow re-running analysis from step_pdf or later (for manual re-runs)

    const submissionJob = await pdfService.queueAnalysis(
      submission.id,
      req.userId,
      submission.currentRound
    );

    logger.info('PDF analysis queued', { submissionId: submission.id, submissionJobId: submissionJob.id });

    res.json({
      message: 'Analysis queued',
      submissionJobId: submissionJob.id,
      status: submissionJob.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  upload,
  uploadSupplemental,
  getAnalysisStatus,
  getFindings,
  triggerAnalysis,
  extractDAS
};
