/**
 * ORCID Extraction Controller
 */

const orcidService = require('../services/orcid/orcid.service');
const logger = require('../utils/logger');

/**
 * Get authors for a submission
 * GET /api/submissions/:id/authors
 */
async function getAuthors(req, res, next) {
  try {
    const data = await orcidService.getAuthors(req.params.id);

    res.json({
      authors: data?.items || [],
      meta: data?.meta || null
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger ORCID extraction (manual re-run)
 * POST /api/submissions/:id/authors/extract
 */
async function triggerExtraction(req, res, next) {
  try {
    const submission = req.submission;

    await orcidService.queueOrcidExtraction(
      submission.id,
      submission.currentRound
    );

    logger.info('ORCID extraction queued', { submissionId: submission.id });

    res.json({
      message: 'ORCID extraction queued'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAuthors,
  triggerExtraction
};
