/**
 * KRT Grounding Controller
 *
 * Exposes the reconciliation between the author's KRT and what detection found:
 * per author row, confirmed / incomplete / not_detected, with the manuscript
 * evidence behind each verdict.
 */

const krtGroundingService = require('../services/krt-grounding/krt-grounding.service');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

/**
 * Get the grounding outcomes for a submission.
 * GET /api/submissions/:id/grounding
 */
async function getGrounding(req, res, next) {
  try {
    const data = await krtGroundingService.getGroundingResult(req.params.id);
    res.json({
      outcomes: data?.outcomes || [],
      unmatchedCandidateRefs: data?.unmatchedCandidateRefs || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger grounding (manual re-run).
 * POST /api/submissions/:id/grounding/regenerate
 */
async function triggerGrounding(req, res, next) {
  try {
    const submission = req.submission;
    const { job, alreadyInFlight } = await krtGroundingService.queueKrtGrounding(
      submission.id, submission.currentRound, req.userId
    );
    logger.info('KRT grounding queued', { submissionId: submission.id, status: job.status });
    res.json({
      message: describeQueueOutcome('KRT grounding', job, alreadyInFlight),
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getGrounding,
  triggerGrounding
};
