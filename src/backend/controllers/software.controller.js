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

    await softwareService.queueSoftwareDetection(
      submission.id,
      submission.currentRound
    );

    logger.info('Software detection queued', { submissionId: submission.id });

    res.json({
      message: 'Software detection queued'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSoftwareMentions,
  triggerDetection
};
