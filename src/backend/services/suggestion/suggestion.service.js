/**
 * Suggestion Service — DIFF-BASED
 *
 * Suggestions are NOT stored. They're computed on every read as the diff
 * between three things:
 *
 *   1. The Generated KRT — produced by the pdf_analysis consolidator from
 *      every detection's items. Stored on `pdf_analysis.result.data.items`.
 *   2. The user's KRT      — `krt_data` rows.
 *   3. User decisions      — only rejections need persistent state, in the
 *                            `rejected_resources` table. Approvals are
 *                            captured implicitly via change_log when
 *                            applyAddRow/applyEdit are called.
 *
 * Suggestion IDs are synthetic and stable across re-runs:
 *   add:<dedup_key>           — a resource in Generated KRT not yet in user KRT
 *   edit:<dedup_key>:<column> — a column-level diff against an existing KRT row
 */

const { Submission, KRTData, RejectedResource } = require('../../models');
const { applyAddRow, applyEdit } = require('../pdf/pdf.service');
const { NotFoundError } = require('../../utils/errors');
const { getGeneratedKrt } = require('../pdf-analysis/pdf-analysis.service');
const { computeSuggestions, parseSuggestionId, indexKrtForLookup } = require('../pdf-analysis/diff-suggestions.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a synthetic 'edit:...:<column>' field key to the GeneratedResource
 * field that supplies the proposed new value.
 */
const COLUMN_TO_GENERATED_FIELD = {
  resourceName:          'resourceName',
  source:                'sourceUrl',
  identifier:            'identifier',
  additionalInformation: 'additionalInformation'
};

/**
 * Resolve the round to use for a /suggestions request. Falls back to the
 * submission's currentRound when not provided.
 */
async function resolveRound(submissionId, round) {
  if (round != null) return round;
  const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
  return submission?.currentRound || 1;
}

/**
 * Convert the rejected_resources rows for this submission/round into the two
 * inputs computeSuggestions expects, plus a list of suggestion-shaped
 * objects representing the rejected items themselves (for the Step 3
 * "Rejected suggestions" carousel).
 */
async function loadRejections(submissionId, round) {
  const rows = await RejectedResource.findAll({
    where: { submissionId, round },
    order: [['rejected_at', 'DESC']]
  });
  const rejectedAdd = new Set();
  const rejectedColumns = new Map();
  const rejectedSuggestions = [];
  for (const r of rows) {
    rejectedSuggestions.push(rejectedRowToSuggestion(r));
    if (r.suggestionId.startsWith('add:')) {
      rejectedAdd.add(r.dedupKey);
    } else if (r.suggestionId.startsWith('edit:') && r.columnName) {
      if (!rejectedColumns.has(r.dedupKey)) rejectedColumns.set(r.dedupKey, new Set());
      rejectedColumns.get(r.dedupKey).add(r.columnName);
    }
  }
  return { rejectedAdd, rejectedColumns, rejectedSuggestions };
}

/**
 * Render a stored rejection row in the suggestion shape that ReviewView and
 * the rest of the frontend already understands (status='rejected' + carousel
 * fields). The audit fields stored on rejected_resources are immutable so
 * this view stays stable even if the Generated KRT later changes.
 */
function rejectedRowToSuggestion(r) {
  const isAdd = r.suggestionId.startsWith('add:');
  const isEdit = r.suggestionId.startsWith('edit:');
  const baseTitle = r.resourceName || r.identifier || r.resourceType || '(rejected resource)';
  return {
    id: r.suggestionId,
    type: isAdd ? 'add_row' : (isEdit ? 'edit' : 'unknown'),
    status: 'rejected',
    source: 'pdf_analysis',
    title: isEdit
      ? `Update ${(r.columnName || '').toString()} of ${baseTitle}`
      : baseTitle,
    description: isAdd
      ? `Add ${r.resourceType || ''}: ${baseTitle}`.trim()
      : (isEdit
          ? `${r.columnName}: → "${r.proposedValue ?? ''}"`
          : 'Rejected suggestion'),
    rejectionReason: r.reason || null,
    rejectedAt: r.rejectedAt,
    data: isEdit
      ? {
          column: r.columnName,
          newValue: r.proposedValue ?? '',
          oldValue: '',          // not preserved in audit; ReviewView shows '(empty)'
          resourceType: r.resourceType,
          resourceName: r.resourceName
        }
      : {
          resourceType: r.resourceType,
          resourceName: r.resourceName,
          identifier: r.identifier,
          newReuse: r.newReuse
        }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read-time suggestion list. Always reflects the current Generated KRT, the
 * current user KRT, and the current set of rejections — no stale state.
 */
async function getAllSuggestions(submissionId, round) {
  const r = await resolveRound(submissionId, round);

  const [generatedKrt, krtRows, rejections] = await Promise.all([
    getGeneratedKrt(submissionId, r),
    KRTData.findAll({ where: { submissionId, round: r } }),
    loadRejections(submissionId, r)
  ]);

  const pending = computeSuggestions(
    generatedKrt,
    krtRows,
    rejections.rejectedAdd,
    rejections.rejectedColumns
  );
  // Append rejected items (already in suggestion-shape with status='rejected')
  // so the existing ReviewView carousel — which filters s.status === 'rejected'
  // — keeps working without any frontend change.
  return { suggestions: [...pending, ...rejections.rejectedSuggestions] };
}

/**
 * Approve a synthetic-id suggestion. Re-resolves the suggestion against the
 * CURRENT Generated KRT (so a stale frontend doesn't apply outdated data),
 * then applies the change to krt_data via the existing apply-helpers. The
 * change_log entry written by those helpers (`source='ai_suggestion'`)
 * provides the audit trail — no extra status flip needed.
 */
async function approveSuggestion(submissionId, suggestionId, userId, modifiedValue, overrides = null) {
  const parsed = parseSuggestionId(suggestionId);
  if (!parsed) throw new NotFoundError('Suggestion');

  const r = await resolveRound(submissionId, null);
  const generatedKrt = await getGeneratedKrt(submissionId, r);
  const resource = generatedKrt.find(g => g.dedupKey === parsed.dedupKey);
  if (!resource) {
    throw new NotFoundError('Suggestion (resource no longer in Generated KRT)');
  }

  if (parsed.kind === 'add') {
    // Per-field overrides let the user change one or more cells of the
    // proposed add_row before approving (most commonly the Resource Type).
    // Falsy/empty values are ignored so an empty form field doesn't blank
    // out the detector's value.
    const ov = overrides || {};
    await applyAddRow(submissionId, {
      resourceType:          ov.resourceType          || resource.resourceType,
      resourceName:          ov.resourceName          || resource.resourceName,
      source:                ov.source                || resource.sourceUrl,
      identifier:            ov.identifier            || resource.identifier,
      newReuse:              ov.newReuse              || resource.newReuse,
      additionalInformation: ov.additionalInformation || resource.additionalInformation
    }, userId, r);
    return { description: resource.resourceName || resource.identifier, type: 'add_row' };
  }

  if (parsed.kind === 'edit') {
    // Use the same alias-aware matcher computeSuggestions ran with — strict
    // dedupKey-equality would miss rows that were paired via name- or token-
    // alias matching when the suggestion was generated.
    const krtRows = await KRTData.findAll({ where: { submissionId, round: r } });
    const krtRow = indexKrtForLookup(krtRows).findMatch(resource);
    if (!krtRow) {
      throw new NotFoundError('Suggestion (matching KRT row not found)');
    }

    const sourceField = COLUMN_TO_GENERATED_FIELD[parsed.column];
    const newValue = modifiedValue ?? (sourceField ? resource[sourceField] : '');

    await applyEdit(submissionId, {
      rowId:    krtRow.id,
      column:   parsed.column,
      newValue
    }, modifiedValue, userId, r);
    return { description: resource.resourceName || resource.identifier, type: 'edit' };
  }

  throw new NotFoundError('Suggestion');
}

/**
 * Reject a synthetic-id suggestion. Inserts an audit row into
 * rejected_resources (snapshot fields immutable). Idempotent on the
 * (submission_id, round, suggestion_id) unique key.
 */
async function rejectSuggestion(submissionId, suggestionId, userId, reason) {
  const parsed = parseSuggestionId(suggestionId);
  if (!parsed) throw new NotFoundError('Suggestion');

  const r = await resolveRound(submissionId, null);
  const generatedKrt = await getGeneratedKrt(submissionId, r);
  const resource = generatedKrt.find(g => g.dedupKey === parsed.dedupKey);
  if (!resource) {
    throw new NotFoundError('Suggestion (resource no longer in Generated KRT)');
  }

  const fields = {
    submissionId,
    round:        r,
    suggestionId,
    dedupKey:     parsed.dedupKey,
    resourceType: resource.resourceType,
    resourceName: resource.resourceName,
    identifier:   resource.identifier,
    newReuse:     resource.newReuse,
    reason:       reason || null,
    rejectedBy:   userId
  };
  if (parsed.kind === 'edit') {
    fields.columnName = parsed.column;
    const sourceField = COLUMN_TO_GENERATED_FIELD[parsed.column];
    fields.proposedValue = sourceField ? resource[sourceField] : null;
  }

  try {
    await RejectedResource.create(fields);
  } catch (err) {
    // Idempotent: clicking reject twice on the same suggestion is a no-op.
    if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
  }

  return {
    description: resource.resourceName || resource.identifier,
    type: parsed.kind === 'add' ? 'add_row' : 'edit'
  };
}

module.exports = {
  getAllSuggestions,
  approveSuggestion,
  rejectSuggestion
};
