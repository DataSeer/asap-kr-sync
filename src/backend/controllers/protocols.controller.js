/**
 * Protocols Detection Controller
 */

const protocolsService = require('../services/protocols/protocols.service');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

/**
 * Get protocols mentions for a submission
 * GET /api/submissions/:id/protocols
 */
async function getProtocolsMentions(req, res, next) {
  try {
    const data = await protocolsService.getProtocolsMentions(req.params.id);

    res.json({
      mentions: data?.items || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger protocols detection (manual re-run)
 * POST /api/submissions/:id/protocols/detect
 */
async function triggerDetection(req, res, next) {
  try {
    const submission = req.submission;

    const { job, alreadyInFlight } = await protocolsService.queueProtocolsDetection(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('Protocols detection queued', { submissionId: submission.id, status: job.status });

    // Say what actually happened — see describeQueueOutcome. There are more
    // than two outcomes: a re-run asked for while the step is in flight is a
    // deliberate no-op, and a step whose dependencies are not done is left
    // waiting. Reporting either as "queued" leaves the user waiting for a run
    // that is not going to start.
    res.json({
      message: describeQueueOutcome('Protocols detection', job, alreadyInFlight),
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProtocolsMentions,
  triggerDetection
};
