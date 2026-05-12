/**
 * Markdown Convert Controller
 */

const markdownConvertService = require('../services/pdf/markdown-convert.service');
const logger = require('../utils/logger');

/**
 * Trigger markdown conversion (manual re-run)
 * POST /api/submissions/:id/markdown/convert
 */
async function triggerConvert(req, res, next) {
  try {
    const submission = req.submission;

    await markdownConvertService.queueMarkdownConvert(
      submission.id,
      submission.currentRound
    );

    logger.info('Markdown conversion queued', { submissionId: submission.id });

    res.json({
      message: 'Markdown conversion queued'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  triggerConvert
};
