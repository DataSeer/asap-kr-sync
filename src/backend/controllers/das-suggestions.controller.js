/**
 * DAS Suggestions Controller
 *
 * Read + re-trigger endpoints for the LM check of the Data/Code Availability
 * Statement. Author-accessible (unlike the raw /jobs payload, which is redacted
 * for authors) so the /availability view can render the suggestions and gate
 * the Continue button on the job's status.
 */

const dasSuggestionsService = require('../services/das-suggestions/das-suggestions.service');

function resolveRound(req) {
  return req.submission?.currentRound || parseInt(req.query.round, 10) || 1;
}

/**
 * GET /api/submissions/:id/das-suggestions
 * Returns { status, suggestions, meta } for the latest DAS-suggestions job.
 */
async function getDasSuggestions(req, res, next) {
  try {
    const data = await dasSuggestionsService.getPersistedDasSuggestions(req.params.id, resolveRound(req));
    res.json(data);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/submissions/:id/das-suggestions/regenerate
 * Re-queues the DAS-suggestions job (e.g. after the author edits the DAS).
 */
async function regenerate(req, res, next) {
  try {
    const jobId = await dasSuggestionsService.queueDasSuggestions(req.params.id, resolveRound(req));
    // No DAS to check → nothing queued (e.g. DAS extraction was cancelled).
    if (!jobId) {
      return res.status(200).json({
        queued: false,
        reason: 'No Data Availability Statement provided — nothing to check.'
      });
    }
    res.status(202).json({ queued: true, jobId });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDasSuggestions,
  regenerate
};
