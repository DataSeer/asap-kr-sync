/**
 * Promoting a step's output into the submission's own data.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   > A step writes only to its own execution. Putting that output into the
 *   > submission is a SEPARATE act, and it is recorded.
 *
 * Before this, three steps wrote submission state directly and nothing said
 * they had. Two things followed, and the second is why the split had to come
 * early rather than late:
 *
 *   1. **A run was not a snapshot.** There is one statement field, the newest
 *      run owns it, so opening run 1 showed you run 2's answer.
 *   2. **A run could not be re-executed without side effects**, which is what
 *      makes replay and evaluation impossible rather than merely awkward.
 *
 * ── Two "current" states, and they are not the same thing ───────────────────
 *
 *   what a module PRODUCED   → its execution, per run   → module and pipeline pages
 *   what the submission HOLDS → applied values          → the editor, the report
 *
 * That is the real answer to "which run is this result from". The statement on
 * the Availability page is not run 3's output; it is the submission's state,
 * with provenance pointing at whichever execution was applied — possibly an
 * older one, and that is correct.
 *
 * ── Why the decision lives here and not in the caller ───────────────────────
 *
 * "Only fill the statement while it is empty" is a rule about WHOSE TEXT WINS,
 * and it was previously buried in the extraction service, where the only way to
 * find it was to already know it was there. A caller now asks to apply and is
 * told what happened; the rules are in one list that can be read end to end.
 */

const logger = require('../../utils/logger');
const { NO_DAS_SENTINEL } = require('../das-suggestions/das-suggestions.service');

/**
 * What may be promoted into a submission, and under what rule.
 *
 * Each target owns three things: where the value lands, whether a given value
 * is allowed to land there, and any state that must move with it.
 */
const TARGETS = {
  /**
   * The Data/Code Availability Statement.
   *
   * Filled from extraction only while empty. The bug this rule exists for: an
   * author whose statement the extractor could not find typed one by hand — the
   * whole reason the manual path exists — and the next extraction replaced it
   * with "Not found". The app undid their work and called it an update.
   */
  data_availability_statement: {
    field: 'dataAvailabilityStatement',
    step: 4,
    decide(submission, value) {
      // The sentinel counts as empty. Extraction is fail-soft and always
      // persists something, so a first pass that found nothing leaves "Not
      // found" in the field — and treating that as occupied would lock out
      // every later extraction, including the one that finally succeeds.
      const current = (submission.dataAvailabilityStatement || '').trim();
      const occupied = current && current !== NO_DAS_SENTINEL;
      if (occupied) return { apply: false, reason: 'a statement is already there' };
      if (current === (value || '').trim()) {
        return { apply: false, reason: 'unchanged' };
      }
      return { apply: true };
    },
    write(submission, value) {
      submission.dataAvailabilityStatement = value;
      // Extractor-authored text has nobody behind it. Any confirmation standing
      // here was about different words, so it does not carry: the Availability
      // check asks again rather than reporting on a statement nobody has read.
      submission.dasConfirmedAt = null;
      submission.dasConfirmedByUserId = null;
    },
    clear(submission) {
      submission.dataAvailabilityStatement = null;
      submission.dasConfirmedAt = null;
      submission.dasConfirmedByUserId = null;
    }
  },

  /**
   * The author list, from GROBID + OpenAlex + the ORCID API.
   *
   * Auto-applied on success and only on success — a `fail` resolves rather than
   * throwing, with `items: []`, so an outage on the final attempt used to
   * replace a good author list with nothing. Now it is logged as well as
   * guarded, which is the difference between "the pipeline set this" and an
   * unexplained change to somebody's paper.
   */
  authors: {
    field: 'authors',
    step: 2,
    decide(submission, value) {
      if (!value?.items?.length) return { apply: false, reason: 'no authors found' };
      return { apply: true };
    },
    write(submission, value) {
      submission.authors = value;
    }
  }
};

/**
 * Render a value for the change log's `old_value` / `new_value` TEXT columns.
 *
 * Truncated, because an author list is kilobytes of JSON and the log is read as
 * a list. The execution holds the full output; this only has to be enough to
 * recognise what changed.
 */
function forLog(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

/**
 * Promote a step's output onto the submission, and record that it happened.
 *
 * Never throws on the logging half. If the change log write fails the value is
 * already on the submission, and undoing a correct write to protect the audit
 * trail would be the wrong trade — the failure is logged loudly instead.
 *
 * @param {object} params
 * @param {object} params.submission - loaded instance; mutated and saved here
 * @param {string} params.target - a key of TARGETS
 * @param {*} params.value - what the step produced
 * @param {string} [params.stepExecutionId] - the execution it came from
 * @param {string} [params.userId] - null when the system is the actor
 * @param {number} [params.round]
 * @param {string} [params.description]
 * @param {object} [params.transaction]
 * @returns {Promise<{applied: boolean, reason: string|null}>}
 */
async function applyToSubmission({
  submission,
  target,
  value,
  stepExecutionId = null,
  userId = null,
  round,
  description,
  transaction
}) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Nothing may be applied to "${target}"`);

  const previous = submission[spec.field];
  const { apply, reason = null } = spec.decide(submission, value);
  if (!apply) return { applied: false, reason };

  spec.write(submission, value);
  await submission.save({ transaction });

  // The value is on the submission whatever happens next. A failure to record
  // the act must not undo a correct write.
  try {
    const { ChangeLog } = require('../../models');
    await ChangeLog.create({
      submissionId: submission.id,
      userId,
      action: 'apply',
      // `pipeline` when nobody chose this; `manual` when a person accepted it.
      source: userId ? 'manual' : 'pipeline',
      step: spec.step,
      round: round ?? submission.currentRound ?? 1,
      columnName: target,
      oldValue: forLog(previous),
      newValue: forLog(value),
      stepExecutionId,
      description: description || `${target} set from a pipeline result`
    }, { transaction });
  } catch (error) {
    logger.error('An apply was not recorded — the value was written anyway', {
      submissionId: submission.id, target, stepExecutionId, error: error.message
    });
  }

  logger.info('Applied a pipeline result', {
    submissionId: submission.id, target, stepExecutionId, byUser: userId || null
  });

  return { applied: true, reason: null };
}

/**
 * Empty an applied field, because the pipeline is about to produce a new one.
 *
 * Asking for DAS extraction again is asking for a fresh reading of the
 * manuscript, and the statement is only ever filled while empty — so without
 * this, a re-extraction on a submission that already has a statement runs, and
 * changes nothing anybody can see.
 *
 * It goes through here rather than being a bare assignment because it destroys
 * data: a user who typed their own statement and then pressed "re-run" loses
 * it. That is the correct behaviour — they asked — but it is exactly the class
 * of silent pipeline write this whole split exists to end, so `oldValue`
 * records what was there.
 *
 * @param {object} params
 * @param {object} params.submission - loaded instance; mutated and saved here
 * @param {string} params.target - a key of TARGETS
 * @param {string} [params.userId] - whoever asked for the re-run
 * @param {number} [params.round]
 * @param {string} [params.description]
 * @param {object} [params.transaction]
 * @returns {Promise<{cleared: boolean}>}
 */
async function clearFromPipeline({
  submission, target, userId = null, round, description, transaction
}) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Nothing may be applied to "${target}"`);
  if (!spec.clear) throw new Error(`"${target}" cannot be cleared`);

  const previous = submission[spec.field];
  // Nothing to lose and nothing to say. A log row per restart of a step that
  // has never produced anything is noise in the one place that must stay
  // readable.
  if (previous === null || previous === undefined || previous === '') {
    return { cleared: false };
  }

  spec.clear(submission);
  await submission.save({ transaction });

  try {
    const { ChangeLog } = require('../../models');
    await ChangeLog.create({
      submissionId: submission.id,
      userId,
      action: 'apply',
      source: userId ? 'manual' : 'pipeline',
      step: spec.step,
      round: round ?? submission.currentRound ?? 1,
      columnName: target,
      oldValue: forLog(previous),
      newValue: null,
      description: description || `${target} cleared for a fresh pipeline result`
    }, { transaction });
  } catch (error) {
    logger.error('A pipeline clear was not recorded — the field was emptied anyway', {
      submissionId: submission.id, target, error: error.message
    });
  }

  return { cleared: true };
}

module.exports = { applyToSubmission, clearFromPipeline, TARGETS };
