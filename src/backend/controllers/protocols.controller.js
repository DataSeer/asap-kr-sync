/**
 * Protocols Detection Controller
 */

const protocolsService = require('../services/protocols/protocols.service');
const logger = require('../utils/logger');

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

    // Say which of the two happened. A re-run asked for while the step is in
    // flight is deliberately a no-op; reporting it as "queued" would leave the
    // user waiting for a second run that is never going to start.
    res.json({
      message: alreadyInFlight ? 'Protocols detection is already running' : 'Protocols detection queued',
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
