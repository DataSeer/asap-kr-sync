/**
 * Datasets Detection Controller
 */

const datasetsService = require('../services/datasets/datasets.service');
const logger = require('../utils/logger');

/**
 * Get dataset mentions for a submission
 * GET /api/submissions/:id/datasets
 */
async function getDatasetMentions(req, res, next) {
  try {
    const data = await datasetsService.getDatasetMentions(req.params.id);

    res.json({
      mentions: data?.items || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger datasets detection (manual re-run)
 * POST /api/submissions/:id/datasets/detect
 */
async function triggerDetection(req, res, next) {
  try {
    const submission = req.submission;

    await datasetsService.queueDatasetDetection(
      submission.id,
      submission.currentRound
    );

    logger.info('Datasets detection queued', { submissionId: submission.id });

    res.json({
      message: 'Datasets detection queued'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDatasetMentions,
  triggerDetection
};
