/**
 * Datasets Detection Controller
 */

const datasetsService = require('../services/datasets/datasets.service');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

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

    // Say what actually happened — see describeQueueOutcome. There are more
    // than two outcomes: a re-run asked for while the step is in flight is a
    // deliberate no-op, and a step whose dependencies are not done is left
    // waiting. Reporting either as "queued" leaves the user waiting for a run
    // that is not going to start.
    res.json({
      message: describeQueueOutcome('Datasets detection', job, alreadyInFlight),
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
