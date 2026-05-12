/**
 * Reports Controller
 */

const reportService = require('../services/reports/report.service');
const s3Service = require('../services/storage/s3.service');
const { Report } = require('../models');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { REPORT_TYPES } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * Generate report
 * POST /api/submissions/:id/reports/generate
 */
async function generate(req, res, next) {
  try {
    const { type } = req.validatedBody;
    const submission = req.submission;

    // Validate submission is at step_report or completed
    if (!['step_report', 'completed'].includes(submission.status)) {
      throw new ValidationError('Must be at report step to generate reports');
    }

    const report = await reportService.generateReport(
      submission.id,
      type,
      req.userId,
      submission.currentRound
    );

    // Status is now step-based and only changes on navigation
    // User clicks "Finish" to set status to 'completed'

    logger.info('Report generated', {
      submissionId: submission.id,
      reportId: report.id,
      type
    });

    res.status(201).json({
      message: 'Report generated successfully',
      report
    });
  } catch (error) {
    next(error);
  }
}

/**
 * List reports for submission
 * GET /api/submissions/:id/reports
 */
async function list(req, res, next) {
  try {
    const reports = await Report.findAll({
      where: { submissionId: req.params.id },
      order: [['createdAt', 'DESC']]
    });

    res.json({ reports });
  } catch (error) {
    next(error);
  }
}

/**
 * Get specific report
 * GET /api/submissions/:id/reports/:reportId
 */
async function getById(req, res, next) {
  try {
    const report = await Report.findOne({
      where: {
        id: req.params.reportId,
        submissionId: req.params.id
      }
    });

    if (!report) {
      throw new NotFoundError('Report');
    }

    res.json({ report });
  } catch (error) {
    next(error);
  }
}

/**
 * Download report (generates presigned URL for S3 files)
 * GET /api/submissions/:id/reports/:reportId/download
 */
async function download(req, res, next) {
  try {
    const report = await Report.findOne({
      where: {
        id: req.params.reportId,
        submissionId: req.params.id
      }
    });

    if (!report) {
      throw new NotFoundError('Report');
    }

    // For Excel/S3 files:
    // - If fileUrl is a full URL (legacy), extract the S3 key
    // - If fileUrl is an S3 key (new format), use directly
    let s3Key = report.fileUrl;
    if (s3Key.startsWith('http')) {
      // Extract key from URL: https://bucket.s3.amazonaws.com/prefix/key -> prefix/key
      const url = new URL(s3Key);
      s3Key = url.pathname.slice(1); // Remove leading slash
    }

    // Generate presigned URL (1 hour expiry)
    const presignedUrl = await s3Service.getPresignedDownloadUrl(s3Key, 3600);

    logger.info('Report download URL generated', {
      reportId: report.id,
      submissionId: req.params.id
    });

    // Return URL as JSON (frontend will open it)
    res.json({ url: presignedUrl });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  generate,
  list,
  getById,
  download
};
