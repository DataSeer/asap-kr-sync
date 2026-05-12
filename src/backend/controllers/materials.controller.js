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

    await materialsService.queueMaterialsDetection(
      submission.id,
      submission.currentRound
    );

    logger.info('Materials detection queued', { submissionId: submission.id });

    res.json({
      message: 'Materials detection queued'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMaterialsMentions,
  triggerDetection
};
