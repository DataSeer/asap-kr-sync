/**
 * Materials Detection Controller
 */

const materialsService = require('../services/materials/materials.service');
const logger = require('../utils/logger');

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

    // Say which of the two happened. A re-run asked for while the step is in
    // flight is deliberately a no-op; reporting it as "queued" would leave the
    // user waiting for a second run that is never going to start.
    res.json({
      message: alreadyInFlight ? 'Materials detection is already running' : 'Materials detection queued',
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
