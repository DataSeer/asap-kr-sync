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

    const job = await orcidService.queueOrcidExtraction(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('ORCID extraction queued', { submissionId: submission.id, status: job.status });

    const alreadyRunning = ['queued', 'processing'].includes(job.status);
    res.json({
      message: alreadyRunning ? 'Author extraction is already running' : 'ORCID extraction queued',
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAuthors,
  triggerExtraction
};
