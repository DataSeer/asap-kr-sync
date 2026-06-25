/**
 * Suggestion Service — LM-GENERATED, PERSISTED
 *
 * Suggestions are produced by the SUGGESTION_GENERATION job (an LM comparison
 * of the author KRT vs the Generated KRT — see kr-comparison.service.js) and
 * persisted on that job's result. This service reads that persisted list and
 * applies the user's accept/reject decisions. It no longer recomputes a diff on
 * every read, so editing the KRT does NOT silently change the suggestions —
 * they only change when the job is (re)run via the Regenerate button.
 *
 * Decisions:
 *   - reject  → audit row in `rejected_resources` (rejected ids are filtered
 *               out of the pending list and re-surface only if regenerated).
 *   - approve → applied to `krt_data` (add / edit / delete) with a change_log
 *               entry (source='ai_suggestion').
 *
 * Suggestion ids (carried from kr-comparison.service):
 *   add:<dedup_key>           edit:<dedup_key>:<column>           delete:<dedup_key>
 */

const { Submission, KRTData, RejectedResource, ChangeLog, ValidationResult, sequelize } = require('../../models');
const { applyAddRow, applyEdit } = require('../pdf/pdf.service');
const { NotFoundError } = require('../../utils/errors');
const { getPersistedSuggestions } = require('./kr-comparison.service');

/**
 * Resolve the round to use. Falls back to the submission's currentRound.
 */
async function resolveRound(submissionId, round) {
  if (round != null) return round;
  const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
  return submission?.currentRound || 1;
}

/**
 * Load rejections: the set of rejected suggestion ids (to hide from pending),
 * plus suggestion-shaped objects for the Step 3 "Rejected suggestions" carousel.
 */
async function loadRejections(submissionId, round) {
  const rows = await RejectedResource.findAll({
    where: { submissionId, round },
    order: [['rejected_at', 'DESC']]
  });
  const rejectedIds = new Set();
  const rejectedSuggestions = [];
  for (const r of rows) {
    rejectedIds.add(r.suggestionId);
    rejectedSuggestions.push(rejectedRowToSuggestion(r));
  }
  return { rejectedIds, rejectedSuggestions };
}

/**
 * Render a stored rejection in the suggestion shape ReviewView understands.
 */
function rejectedRowToSuggestion(r) {
  const isAdd = r.suggestionId.startsWith('add:');
  const isEdit = r.suggestionId.startsWith('edit:');
  const isDelete = r.suggestionId.startsWith('delete:');
  const baseTitle = r.resourceName || r.identifier || r.resourceType || '(rejected resource)';
  return {
    id: r.suggestionId,
    type: isAdd ? 'add_row' : (isEdit ? 'edit' : (isDelete ? 'delete_row' : 'unknown')),
    status: 'rejected',
    source: 'krt_comparison',
    title: isEdit ? `Update ${(r.columnName || '').toString()} of ${baseTitle}` : baseTitle,
    description: isAdd
      ? `Add ${r.resourceType || ''}: ${baseTitle}`.trim()
      : (isEdit
          ? `${r.columnName}: → "${r.proposedValue ?? ''}"`
          : (isDelete ? `Remove: ${baseTitle}` : 'Rejected suggestion')),
    rejectionReason: r.reason || null,
    rejectedAt: r.rejectedAt,
    data: isEdit
      ? { column: r.columnName, newValue: r.proposedValue ?? '', oldValue: '', resourceType: r.resourceType, resourceName: r.resourceName }
      : { resourceType: r.resourceType, resourceName: r.resourceName, identifier: r.identifier, newReuse: r.newReuse }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Suggestion list = the persisted LM suggestions (minus the ones the user has
 * rejected) + the rejected items (for the audit carousel).
 */
async function getAllSuggestions(submissionId, round) {
  const r = await resolveRound(submissionId, round);
  const [persisted, rejections] = await Promise.all([
    getPersistedSuggestions(submissionId, r),
    loadRejections(submissionId, r)
  ]);
  const pending = persisted.filter(s => !rejections.rejectedIds.has(s.id));
  return { suggestions: [...pending, ...rejections.rejectedSuggestions] };
}

/** Find a persisted suggestion by id for the current round. */
async function findSuggestion(submissionId, suggestionId) {
  const r = await resolveRound(submissionId, null);
  const persisted = await getPersistedSuggestions(submissionId, r);
  const sug = persisted.find(s => s.id === suggestionId);
  return { round: r, sug };
}

/**
 * Approve a persisted suggestion: apply it to krt_data. Add/edit reuse the
 * existing apply-helpers; delete removes the row transactionally.
 */
async function approveSuggestion(submissionId, suggestionId, userId, modifiedValue, overrides = null) {
  const { round: r, sug } = await findSuggestion(submissionId, suggestionId);
  if (!sug) throw new NotFoundError('Suggestion');

  if (sug.type === 'add_row') {
    const ov = overrides || {};
    await applyAddRow(submissionId, {
      resourceType:          ov.resourceType          || sug.data.resourceType,
      resourceName:          ov.resourceName          || sug.data.resourceName,
      source:                ov.source                || sug.data.source,
      identifier:            ov.identifier            || sug.data.identifier,
      newReuse:              ov.newReuse              || sug.data.newReuse,
      // AI-driven inserts never populate ADDITIONAL INFORMATION (unless the
      // user typed an override).
      additionalInformation: ov.additionalInformation || ''
    }, userId, r);
    return { description: sug.data.resourceName || sug.data.identifier, type: 'add_row' };
  }

  if (sug.type === 'edit') {
    const newValue = modifiedValue ?? sug.data.newValue;
    await applyEdit(submissionId, {
      rowId: sug.data.rowId, column: sug.data.column,
      newValue, oldValue: sug.data.oldValue, resourceName: sug.data.resourceName
    }, modifiedValue, userId, r);
    return { description: sug.data.resourceName, type: 'edit' };
  }

  if (sug.type === 'delete_row') {
    await applyDeleteRow(submissionId, sug.data.rowId, userId, r, sug.data.resourceName);
    return { description: sug.data.resourceName, type: 'delete_row' };
  }

  throw new NotFoundError('Suggestion');
}

/** Delete a KRT row (accepted "remove" suggestion), transactionally + audited. */
async function applyDeleteRow(submissionId, rowId, userId, round, resourceName) {
  const row = await KRTData.findOne({ where: { submissionId, id: rowId, round } });
  if (!row) throw new NotFoundError('KRT row');
  await sequelize.transaction(async (t) => {
    await ChangeLog.create({
      submissionId, userId, action: 'delete_row', source: 'ai_suggestion', step: 2, round: round || 1,
      rowId: row.id, description: `Deleted row: ${resourceName || row.resourceName || ''}`
    }, { transaction: t });
    await ValidationResult.destroy({ where: { submissionId, rowId: row.id }, transaction: t });
    await row.destroy({ transaction: t });
  });
}

/**
 * Reject a persisted suggestion: insert an audit row into rejected_resources
 * (idempotent on the unique key). The rejected id is then filtered out of the
 * pending list until a regenerate brings a fresh one.
 */
async function rejectSuggestion(submissionId, suggestionId, userId, reason) {
  const { round: r, sug } = await findSuggestion(submissionId, suggestionId);
  if (!sug) throw new NotFoundError('Suggestion');

  const fields = {
    submissionId, round: r, suggestionId,
    dedupKey:     sug.dedupKey,
    resourceType: sug.data.resourceType,
    resourceName: sug.data.resourceName,
    identifier:   sug.data.identifier,
    newReuse:     sug.data.newReuse,
    reason:       reason || null,
    rejectedBy:   userId
  };
  if (sug.type === 'edit') {
    fields.columnName = sug.data.column;
    fields.proposedValue = sug.data.newValue;
  }

  try {
    await RejectedResource.create(fields);
  } catch (err) {
    if (err?.name !== 'SequelizeUniqueConstraintError') throw err; // reject twice = no-op
  }

  return { description: sug.data.resourceName || sug.data.identifier, type: sug.type };
}

module.exports = {
  getAllSuggestions,
  approveSuggestion,
  rejectSuggestion
};
