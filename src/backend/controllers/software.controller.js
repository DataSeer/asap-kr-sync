/**
 * Software Detection Controller
 */

const softwareService = require('../services/software/software.service');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

/**
 * Get software mentions for a submission
 * GET /api/submissions/:id/software
 */
async function getSoftwareMentions(req, res, next) {
  try {
    const data = await softwareService.getSoftwareMentions(req.params.id);

    res.json({
      mentions: data?.items || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger software detection (manual re-run)
 * POST /api/submissions/:id/software/detect
 */
async function triggerDetection(req, res, next) {
  try {
    const submission = req.submission;

    const { job, alreadyInFlight } = await softwareService.queueSoftwareDetection(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('Software detection queued', { submissionId: submission.id, status: job.status });

    // Say what actually happened — see describeQueueOutcome. There are more
    // than two outcomes: a re-run asked for while the step is in flight is a
    // deliberate no-op, and a step whose dependencies are not done is left
    // waiting. Reporting either as "queued" leaves the user waiting for a run
    // that is not going to start.
    res.json({
      message: describeQueueOutcome('Software detection', job, alreadyInFlight),
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSoftwareMentions,
  triggerDetection
};
