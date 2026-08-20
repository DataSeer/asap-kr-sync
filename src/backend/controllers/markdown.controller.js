/**
 * Markdown Convert Controller
 */

const markdownConvertService = require('../services/pdf/markdown-convert.service');
const s3Service = require('../services/storage/s3.service');
const { File } = require('../models');
const { FILE_TYPES } = require('../config/constants');
const { NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * The converted text of the manuscript.
 *
 * Served through the API rather than as a presigned S3 link because the page
 * DISPLAYS it — a cross-origin fetch of a presigned URL depends on the
 * bucket's CORS policy, which is not something a view should be hostage to.
 *
 * GET /api/submissions/:id/markdown
 */
async function getMarkdown(req, res, next) {
  try {
    const submission = req.submission;
    const round = submission.currentRound || 1;

    const file = await File.findOne({
      where: { submissionId: submission.id, type: FILE_TYPES.MARKDOWN, round },
      order: [['version', 'DESC']]
    });
    if (!file) throw new NotFoundError('Converted markdown');

    const buffer = await s3Service.downloadFile(file.s3Key);
    const content = buffer.toString('utf-8');

    res.json({
      content,
      fileName: file.fileName,
      length: content.length,
      version: file.version,
      round
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger markdown conversion (manual re-run)
 * POST /api/submissions/:id/markdown/convert
 */
async function triggerConvert(req, res, next) {
  try {
    const submission = req.submission;

    const job = await markdownConvertService.queueMarkdownConvert(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('Markdown conversion queued', { submissionId: submission.id, status: job.status });

    // Say which of the two happened. A re-run asked for while a conversion is
    // already in flight is deliberately a no-op — reporting it as "queued"
    // would have the user waiting for a second run that is never going to
    // start.
    const alreadyRunning = ['queued', 'processing'].includes(job.status);
    res.json({
      message: alreadyRunning ? 'Markdown conversion is already running' : 'Markdown conversion queued',
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  triggerConvert,
  getMarkdown
};
