/**
 * Materials Detection Controller
 */

const materialsService = require('../services/materials/materials.service');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

/**
 * Get materials mentions for a submission
 * GET /api/submissions/:id/materials
 */
async function getMaterialsMentions(req, res, next) {
  try {
    const data = await materialsService.getMaterialsMentions(req.params.id);

    res.json({
      mentions: data?.items || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger materials detection (manual re-run)
 * POST /api/submissions/:id/materials/detect
 */
async function triggerDetection(req, res, next) {
  try {
    const submission = req.submission;

    const { job, alreadyInFlight } = await materialsService.queueMaterialsDetection(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('Materials detection queued', { submissionId: submission.id, status: job.status });

    // Say what actually happened — see describeQueueOutcome. There are more
    // than two outcomes: a re-run asked for while the step is in flight is a
    // deliberate no-op, and a step whose dependencies are not done is left
    // waiting. Reporting either as "queued" leaves the user waiting for a run
    // that is not going to start.
    res.json({
      message: describeQueueOutcome('Materials detection', job, alreadyInFlight),
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMaterialsMentions,
  triggerDetection
};
