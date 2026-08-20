/**
 * Software Detection Controller
 */

const softwareService = require('../services/software/software.service');
const logger = require('../utils/logger');

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

    // Say which of the two happened. A re-run asked for while the step is in
    // flight is deliberately a no-op; reporting it as "queued" would leave the
    // user waiting for a second run that is never going to start.
    res.json({
      message: alreadyInFlight ? 'Software detection is already running' : 'Software detection queued',
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
