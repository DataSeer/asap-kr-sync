/**
 * Identifier Detection Controller
 */

const identifierDetectionService = require('../services/identifier-detection/identifier-detection.service');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

/**
 * Get identifier-detection mentions for a submission.
 * GET /api/submissions/:id/identifiers
 */
async function getIdentifierMentions(req, res, next) {
  try {
    const data = await identifierDetectionService.getIdentifierMentions(req.params.id);
    res.json({
      mentions: data?.items || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger identifier detection (manual re-run).
 * POST /api/submissions/:id/identifiers/detect
 */
async function triggerDetection(req, res, next) {
  try {
    const submission = req.submission;
    const { job, alreadyInFlight } = await identifierDetectionService.queueIdentifierDetection(
      submission.id,
      submission.currentRound,
      req.userId
    );
    logger.info('Identifier detection queued', { submissionId: submission.id, status: job.status });
    res.json({
      message: describeQueueOutcome('Identifier detection', job, alreadyInFlight),
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getIdentifierMentions,
  triggerDetection
};
