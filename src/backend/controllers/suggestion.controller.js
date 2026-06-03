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
    const { suggestionId, modifiedValue, overrides } = req.validatedBody;
    const round = req.submission.currentRound;

    const result = await suggestionService.approveSuggestion(
      req.params.id,
      suggestionId,
      req.userId,
      modifiedValue,
      overrides || null
    );

    // Treat any non-empty `overrides` or `modifiedValue` as a user edit. The
    // frontend only sends those fields when the user actually changed cells
    // from the AI-proposed values, so this flag stays accurate without the
    // controller having to diff anything itself.
    const userEdited = !!(modifiedValue || (overrides && Object.keys(overrides).length > 0));

    // Log the change
    await ChangeLog.create({
      submissionId: req.params.id,
      userId: req.userId,
      action: 'approve_change',
      step: 2,
      round,
      description: userEdited
        ? `Approved suggestion (user edited): ${result.description}`
        : `Approved suggestion: ${result.description}`,
      metadata: { suggestionId, userEdited }
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

/**
 * Bulk-approve multiple suggestions. Each item is processed independently;
 * failures for one item don't block the rest, but a single change-log entry
 * is written per item via the underlying approve flow. The response includes
 * a per-item result so the frontend can surface partial success.
 */
async function bulkApproveSuggestions(req, res, next) {
  try {
    const { items } = req.validatedBody;
    const round = req.submission.currentRound;
    const submissionId = req.params.id;

    const results = [];
    for (const item of items) {
      try {
        const r = await suggestionService.approveSuggestion(
          submissionId,
          item.suggestionId,
          req.userId,
          item.modifiedValue ?? null,
          item.overrides || null
        );
        const itemUserEdited = !!(item.modifiedValue || (item.overrides && Object.keys(item.overrides).length > 0));
        await ChangeLog.create({
          submissionId,
          userId: req.userId,
          action: 'approve_change',
          step: 2,
          round,
          description: itemUserEdited
            ? `Approved suggestion (bulk, user edited): ${r.description}`
            : `Approved suggestion (bulk): ${r.description}`,
          metadata: { suggestionId: item.suggestionId, bulk: true, userEdited: itemUserEdited }
        });
        results.push({ suggestionId: item.suggestionId, status: 'approved', description: r.description });
      } catch (err) {
        results.push({
          suggestionId: item.suggestionId,
          status: 'failed',
          error: err.message
        });
      }
    }

    const approvedCount = results.filter(r => r.status === 'approved').length;
    logger.info('Bulk suggestion approve', {
      submissionId,
      userId: req.userId,
      requested: items.length,
      approved: approvedCount
    });

    res.json({
      message: `${approvedCount}/${items.length} suggestion${items.length > 1 ? 's' : ''} approved`,
      results
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Bulk-reject multiple suggestions. Same partial-success semantics as
 * bulk-approve.
 */
async function bulkRejectSuggestions(req, res, next) {
  try {
    const { items } = req.validatedBody;
    const round = req.submission.currentRound;
    const submissionId = req.params.id;

    const results = [];
    for (const item of items) {
      try {
        const r = await suggestionService.rejectSuggestion(
          submissionId,
          item.suggestionId,
          req.userId,
          item.reason ?? null
        );
        await ChangeLog.create({
          submissionId,
          userId: req.userId,
          action: 'reject_change',
          step: 2,
          round,
          description: `Rejected suggestion (bulk): ${r.description}`,
          metadata: { suggestionId: item.suggestionId, reason: item.reason, bulk: true }
        });
        results.push({ suggestionId: item.suggestionId, status: 'rejected', description: r.description });
      } catch (err) {
        results.push({
          suggestionId: item.suggestionId,
          status: 'failed',
          error: err.message
        });
      }
    }

    const rejectedCount = results.filter(r => r.status === 'rejected').length;
    logger.info('Bulk suggestion reject', {
      submissionId,
      userId: req.userId,
      requested: items.length,
      rejected: rejectedCount
    });

    res.json({
      message: `${rejectedCount}/${items.length} suggestion${items.length > 1 ? 's' : ''} rejected`,
      results
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSuggestions,
  approveSuggestion,
  rejectSuggestion,
  bulkApproveSuggestions,
  bulkRejectSuggestions
};
