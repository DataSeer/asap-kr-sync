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
    const result = await dasSuggestionsService.queueDasSuggestions(req.params.id, resolveRound(req), req.userId);

    // Nothing to check — the author never provided a statement, or extraction
    // was cancelled.
    if (result.reason === 'no_statement') {
      return res.status(200).json({
        queued: false,
        reason: 'No Data Availability Statement provided — nothing to check.'
      });
    }

    // Accepted, but the step is gated to the Availability step. Reported as its
    // own case: saying "not queued" here reads as a refusal, and saying
    // "queued" would have the client poll for a job that is not going to start
    // until the submission moves.
    if (result.reason === 'gated') {
      return res.status(202).json({
        queued: false,
        pending: true,
        status: result.status,
        reason: 'The check runs when you reach the Availability Statement step.'
      });
    }

    res.status(202).json({ queued: true, jobId: result.jobId });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDasSuggestions,
  regenerate
};
