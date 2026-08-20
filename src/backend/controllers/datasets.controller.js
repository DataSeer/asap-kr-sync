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

    const { job, alreadyInFlight } = await datasetsService.queueDatasetDetection(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('Datasets detection queued', { submissionId: submission.id, status: job.status });

    // Say which of the two happened. A re-run asked for while the step is in
    // flight is deliberately a no-op; reporting it as "queued" would leave the
    // user waiting for a second run that is never going to start.
    res.json({
      message: alreadyInFlight ? 'Datasets detection is already running' : 'Datasets detection queued',
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDatasetMentions,
  triggerDetection
};
