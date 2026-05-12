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

    await protocolsService.queueProtocolsDetection(
      submission.id,
      submission.currentRound
    );

    logger.info('Protocols detection queued', { submissionId: submission.id });

    res.json({
      message: 'Protocols detection queued'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProtocolsMentions,
  triggerDetection
};
