/**
 * Suggestion Controller
 * Unified endpoint for suggestions from all sources (PDF Analysis, Software Detection, etc.)
 */

const suggestionService = require('../services/suggestion/suggestion.service');
const { ChangeLog } = require('../models');
const logger = require('../utils/logger');

/**
 * Get all suggestions for a submission
 * GET /api/submissions/:id/suggestions
 */
async function getSuggestions(req, res, next) {
  try {
    const result = await suggestionService.getAllSuggestions(
      req.params.id,
      req.submission.currentRound
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Approve a suggestion
 * POST /api/submissions/:id/suggestions/approve
 */
async function approveSuggestion(req, res, next) {
  try {
    const { suggestionId, modifiedValue } = req.validatedBody;
    const round = req.submission.currentRound;

    const result = await suggestionService.approveSuggestion(
      req.params.id,
      suggestionId,
      req.userId,
      modifiedValue
    );

    // Log the change
    await ChangeLog.create({
      submissionId: req.params.id,
      userId: req.userId,
      action: 'approve_change',
      step: 2,
      round,
      description: `Approved suggestion: ${result.description}`,
      metadata: { suggestionId }
    });

    logger.info('Suggestion approved', {
      submissionId: req.params.id,
      suggestionId,
      userId: req.userId
    });

    res.json({
      message: 'Suggestion approved',
      result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Reject a suggestion
 * POST /api/submissions/:id/suggestions/reject
 */
async function rejectSuggestion(req, res, next) {
  try {
    const { suggestionId, reason } = req.validatedBody;
    const round = req.submission.currentRound;

    const result = await suggestionService.rejectSuggestion(
      req.params.id,
      suggestionId,
      req.userId,
      reason
    );

    // Log the rejection
    await ChangeLog.create({
      submissionId: req.params.id,
      userId: req.userId,
      action: 'reject_change',
      step: 2,
      round,
      description: `Rejected suggestion: ${result.description}`,
      metadata: { suggestionId, reason }
    });

    logger.info('Suggestion rejected', {
      submissionId: req.params.id,
      suggestionId,
      userId: req.userId
    });

    res.json({
      message: 'Suggestion rejected',
      result
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSuggestions,
  approveSuggestion,
  rejectSuggestion
};
