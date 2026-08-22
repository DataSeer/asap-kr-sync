/**
 * The pipeline's logbook.
 *
 * Every enqueue opens a run; every terminal transition closes it. The job row
 * keeps describing the CURRENT run — the pipeline reads it and that must not
 * change — while this records what happened, run by run.
 *
 * Two rules govern everything here.
 *
 * **1. It must never break a run.** Every write is wrapped: a failure logs and
 * carries on. A missing history row is recoverable and visible; a pipeline step
 * that stops because its logbook threw is neither. History is an audit sidecar,
 * not a dependency of the work it describes.
 *
 * **2. A run begins at ENQUEUE, not when data is produced.** That is the moment
 * somebody — or the pipeline — asked for it, and it is why a disabled module, a
 * failed run and a cancelled run all get records. pg-boss retries are attempts
 * WITHIN a run and belong to `retryCount`; they never open a new one.
 */

const logger = require('../../utils/logger');

/** Terminal statuses — the point at which a run stops being the live one. */
const TERMINAL = ['complete', 'failed', 'cancelled'];

/**
 * Run a history write, swallowing any failure. See rule 1.
 *
 * @param {string} what - named in the log line if it goes wrong
 * @param {Function} fn
 * @returns {Promise<*>} the result, or null if it failed
 */
async function guarded(what, fn) {
  try {
    return await fn();
  } catch (error) {
    logger.error(`Run history: ${what} failed — the run itself is unaffected`, {
      error: error.message
    });
    return null;
  }
}

/**
 * The submission's documents as they stand when a run opens.
 *
 * Recorded because a run freezes what its MODULE read, which is not the same
 * thing: `software_detection` records only the markdown, and no detector ever
 * opens the KRT — so without this there is no way to say which table or which
 * PDF a run was contemporaneous with.
 *
 * **References, not copies.** Files are versioned in S3 (`name_v1.pdf`,
 * `name_v2.pdf`), so a replaced document leaves the earlier version at its own
 * key and the reference stays valid. Duplicating megabytes per run to record
 * something that already cannot change would be storage for nothing.
 *
 * `sha256` is deliberately absent: computing it means downloading the file on
 * every enqueue, and the version plus the key already identify it exactly. The
 * modules that DO read a document hash it, because they have the bytes in hand.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object>} `{ krt, pdf, markdown }`, each a ref or absent
 */
async function captureDocuments(submissionId, round) {
  const { File } = require('../../models');
  const { FILE_TYPES } = require('../../config/constants');

  const wanted = {
    krt: FILE_TYPES.KRT,
    pdf: FILE_TYPES.PDF,
    markdown: FILE_TYPES.MARKDOWN
  };

  // What the ROUND is reading, when it has already settled on something. Once
  // an input is frozen, a step enqueued afterwards will read the frozen file
  // however many versions have been uploaded since — so recording the newest
  // would put a document in the run record that the run never opened.
  //
  // Read-only: freezing is the reader's job, at read time. A step enqueued
  // before anything has frozen records the newest, which is what it will freeze
  // when it runs.
  const { SubmissionInputFreeze } = require('../../models');
  const freezes = new Map(
    (await SubmissionInputFreeze.findAll({ where: { submissionId, round } }))
      .map((freeze) => [freeze.inputKind, freeze])
  );

  const documents = {};
  for (const [name, type] of Object.entries(wanted)) {
    const frozenId = freezes.get(name)?.fileId;
    // Newest version of that type in this round. A step that runs before the
    // markdown exists simply records no markdown, which is the truth about that
    // run.
    const file = frozenId
      ? await File.findByPk(frozenId)
      : await File.findOne({
        where: { submissionId, type, round },
        order: [['version', 'DESC']]
      });
    if (!file) continue;
    documents[name] = {
      fileId: file.id,
      fileName: file.fileName,
      type: file.type,
      version: file.version,
      s3Key: file.s3Key,
      bytes: file.size ?? null
    };
  }
  return documents;
}

/**
 * Open an execution for a step that has just been enqueued.
 *
 * ── It belongs to a pipeline run, and the run must already exist ────────────
 *
 * Every entry point — starting a submission, a restart, a retry, a replaced PDF
 * — opens its run BEFORE enqueueing anything, so the run this execution belongs
 * to is simply the round's current one. Resolved here rather than threaded
 * through six call sites, which is a real trade: two restarts racing would put
 * an execution in the wrong run. That race already exists in the scheduler and
 * is not made worse by reading it here.
 *
 * If there is no run, this refuses rather than writing an orphan. An execution
 * belonging to no run is unreachable from the model everything else is built
 * on — it would sit in the table and appear on no screen — so a loud error and
 * no row is the better outcome.
 *
 * The execution carries no number of its own. It used to, allocated per step,
 * and that number meant something different from the one the user was shown —
 * the ambiguity the whole model was changed to remove. UNIQUE(pipeline_run_id,
 * job_type) is the backstop now, and it states the invariant directly: a step
 * executes at most once in a run, and a second attempt is a new run.
 *
 * @param {object} job - the SubmissionJob row being enqueued
 * @param {object} [opts]
 * @param {string} [opts.userId] - who asked, when a person did
 * @param {string} [opts.triggerKind] - 'manual' | 'pipeline' | 'reconciler'
 * @returns {Promise<object|null>} the new execution, or null if it could not be recorded
 */
async function openRun(job, { userId = null, triggerKind = null } = {}) {
  return guarded('opening a run', async () => {
    const { StepExecution, SubmissionJob, sequelize } = require('../../models');
    const pipelineRuns = require('./pipeline-run.service');

    const round = job.round ?? 1;
    const pipelineRun = await pipelineRuns.currentRun(job.submissionId, round);
    if (!pipelineRun) {
      logger.error('Run history: a step was enqueued outside any pipeline run', {
        submissionId: job.submissionId, jobType: job.jobType, round
      });
      return null;
    }

    const [rows] = await sequelize.query(`
      INSERT INTO "step_executions" (
        id, pipeline_run_id, submission_job_id, submission_id, job_type, round,
        status, triggered_by_user_id, trigger_kind, s3_prefix,
        created_at, updated_at
      )
      VALUES (
        gen_random_uuid(), :pipelineRunId, :jobId, :submissionId, :jobType, :round,
        'queued'::"enum_step_executions_status", :userId, :triggerKind,
        -- Keyed by the PIPELINE run number. "Everything run 2 produced" is then
        -- one prefix per step rather than a lookup, and the number in the path
        -- is the number the user was shown.
        'jobs/' || :jobType || '/run-' || :pipelineRunNumber,
        NOW(), NOW()
      )
      RETURNING id
    `, {
      replacements: {
        pipelineRunId: pipelineRun.id,
        pipelineRunNumber: pipelineRun.runNumber,
        jobId: job.id,
        submissionId: job.submissionId,
        jobType: job.jobType,
        round,
        userId: userId || null,
        triggerKind: triggerKind || null
      }
    });

    const created = rows[0];

    // The run declared this step when it was created; this is where the
    // placeholder stops being a placeholder.
    await pipelineRuns.attachExecution(pipelineRun.id, job.jobType, created.id);
    // How many times this STEP has executed in the round. No longer the run
    // number — that belongs to the pipeline run — but still worth having:
    // "has this been re-run" is a different question from "which run is this",
    // and a carried-over step makes the two diverge.
    await SubmissionJob.increment('runCount', { by: 1, where: { id: job.id } });

    const run = await StepExecution.findByPk(created.id);

    // After the row exists, deliberately: reading the file table is the part
    // most likely to be slow or to fail, and a run recorded without its
    // document set is far better than no run record at all.
    try {
      const documents = await captureDocuments(job.submissionId, job.round ?? 1);
      if (Object.keys(documents).length) await run.update({ inputs: { documents } });
    } catch (error) {
      logger.warn('Run history: could not record the run\'s documents', { error: error.message });
    }

    return run;
  });
}

/**
 * The execution's attempt list, with this delivery's tries appended.
 *
 * Appended rather than replaced, because a pg-boss re-delivery is another
 * attempt at the SAME execution: its ambient store starts empty, and writing
 * that over the existing array would erase the earlier deliveries — which are
 * the ones worth reading.
 *
 * Drained rather than read: `markRetrying` and `markFailed` can both fire in
 * one delivery, and a peek would record the same tries twice.
 *
 * The delivery number groups client tries under the queue try that contained
 * them, which is what makes "retried twice" unambiguous — two layers retry, and
 * the interesting runs are the ones where both did.
 *
 * @param {object} run - the StepExecution instance
 * @param {object} outcome
 * @param {boolean} outcome.ok
 * @param {string} [outcome.error]
 * @param {number} [outcome.delivery] - pg-boss retry count + 1
 * @returns {object[]}
 */
function attemptsWith(run, { ok, error = null, delivery = 1 }) {
  const attemptLog = require('../../utils/attempt-log');
  const existing = Array.isArray(run.attempts) ? run.attempts : [];
  const fresh = attemptLog.drain().map((attempt) => ({ ...attempt, delivery }));

  fresh.push({
    at: new Date().toISOString(),
    layer: 'queue',
    delivery,
    ok,
    engine: null,
    error: error ? String(error).slice(0, 500) : null,
    httpStatus: null
  });

  return [...existing, ...fresh].map((attempt, index) => ({ ...attempt, n: index + 1 }));
}

/**
 * The execution currently open for a step: the most recently created.
 *
 * By `created_at` rather than by a number of its own, which the execution no
 * longer has. Ordering is the same — executions are created in order, and a
 * step executes at most once per run, which UNIQUE(pipeline_run_id, job_type)
 * enforces.
 *
 * @param {string} submissionJobId
 * @returns {Promise<object|null>}
 */
async function currentRun(submissionJobId) {
  const { StepExecution } = require('../../models');
  return StepExecution.findOne({
    where: { submissionJobId },
    order: [['createdAt', 'DESC']]
  });
}

/**
 * Update the open run in place.
 *
 * Used for the transitions that do NOT end a run — a worker picking the job up,
 * and a retry. A retry updates `retryCount` on the same run precisely because
 * pg-boss attempts are not separate runs.
 *
 * @param {object} job
 * @param {object} fields - StepExecution attributes
 */
async function touchRun(job, fields, attemptOutcome = null) {
  return guarded('updating a run', async () => {
    const run = await currentRun(job.id);
    if (!run) return null;
    const attempts = attemptOutcome
      ? { attempts: attemptsWith(run, attemptOutcome) }
      : {};
    return run.update({ ...fields, ...attempts });
  });
}

/**
 * Close the open run, copying what the job row now holds.
 *
 * Reads the outcome out of the service snapshot the worker just wrote, so the
 * run records the configuration it ran under — including `off`, which is what
 * makes a disabled module's empty result readable as a configuration rather
 * than as a finding about the manuscript.
 *
 * @param {object} job - the SubmissionJob row, already in its terminal state
 */
async function closeRun(job) {
  return guarded('closing a run', async () => {
    const run = await currentRun(job.id);
    if (!run) return null;

    const outcome = job.result?.service?.outcome || {};
    const startedAt = job.startedAt || run.startedAt;
    const completedAt = job.completedAt || new Date();

    return run.update({
      status: job.status,
      outcomeState: outcome.state ?? null,
      outcomeSource: outcome.source ?? null,
      failReason: outcome.failReason ?? null,
      externalError: outcome.externalError ?? job.errorMessage ?? null,
      startedAt,
      completedAt,
      // Prefer the run's own measurement; fall back to the wall clock between
      // the two timestamps.
      durationMs: job.result?.timing?.totalMs
        ?? (startedAt ? completedAt - new Date(startedAt) : null),
      retryCount: job.retryCount ?? 0,
      attempts: attemptsWith(run, {
        ok: job.status === 'complete',
        error: job.errorMessage || outcome.externalError || null,
        delivery: (job.retryCount ?? 0) + 1
      }),
      counts: job.result?.counts ?? null,
      result: job.result ?? null,
      logs: job.logs ?? null
    });
  });
}

/**
 * Record that a person stopped this execution.
 *
 * Separate from `closeRun`, which copies whatever the job row holds: who
 * cancelled is not on the job row, and inventing a place for it there would put
 * the fact back on the thing that gets reused.
 *
 * @param {object} job - the SubmissionJob row, already `cancelled`
 * @param {object} [opts]
 * @param {string} [opts.userId] - who stopped it
 */
async function recordCancellation(job, { userId = null } = {}) {
  return guarded('recording a cancellation', async () => {
    const run = await currentRun(job.id);
    if (!run || run.cancelledAt) return null;
    return run.update({ cancelledAt: new Date(), cancelledByUserId: userId || null });
  });
}

/**
 * Record a response that arrived after the cancel, and was thrown away.
 *
 * An in-flight external call cannot be stopped. The promise is abandoned, the
 * call completes, and it is billed — so dropping the answer silently means the
 * money was spent and the record says nothing. This is what makes "did we pay
 * for something we threw away, and who threw it away" answerable rather than
 * inferred.
 *
 * The token tally is read here rather than passed in, from the same ambient
 * store `markComplete` uses: it is the only number that answers the "did we
 * pay" half, and by this point the job row will never carry it.
 *
 * Appended, not overwritten. A cancelled step can produce more than one late
 * answer — a retry already in flight when the cancel landed — and the second
 * arriving is not a reason to forget the first.
 *
 * @param {object} job - the SubmissionJob row, in its `cancelled` state
 * @param {object} what - `{ outcome, error, counts }`, whatever there is
 */
async function recordDiscarded(job, what = {}) {
  return guarded('recording a discarded response', async () => {
    const run = await currentRun(job.id);
    if (!run) return null;

    const tokenUsage = require('../../utils/token-usage');
    const previous = Array.isArray(run.discarded) ? run.discarded : [];

    return run.update({
      discarded: [...previous, {
        at: new Date().toISOString(),
        outcome: what.outcome || null,
        error: what.error ? String(what.error).slice(0, 500) : null,
        counts: what.counts || null,
        // What the abandoned call cost. Absent when no model was involved.
        tokens: tokenUsage.current()
      }]
    });
  });
}

/**
 * Copy the run's payload again, once the job logger has finished writing it.
 *
 * `closeRun` runs from `markComplete`, and the logger's `flush()` runs AFTER
 * that — it is what writes `result.files` (the S3 keys of every raw response)
 * and `logs`. So the run's copy was taken one step too early and every run was
 * recorded without its artefacts or its log, which is most of what a past run
 * is worth reading for.
 *
 * @param {object} job - the SubmissionJob row, after flush has saved it
 */
async function syncRunPayload(job) {
  return guarded('syncing a run payload', async () => {
    const run = await currentRun(job.id);
    if (!run) return null;

    // A cancelled execution has no result, by definition — and the logger's
    // flush runs from the worker that was interrupted, so without this the
    // answer the user threw away comes straight back in as the run's output.
    // Every page then renders it as this run's finding, next to a status line
    // saying the run was cancelled.
    //
    // The LOG is still worth keeping: it is the record of what the abandoned
    // call did, and it is the only place the timing of it survives.
    if (run.status === 'cancelled') {
      return run.update({ logs: job.logs ?? null });
    }

    return run.update({
      result: job.result ?? null,
      logs: job.logs ?? null,
      counts: job.result?.counts ?? null
    });
  });
}

module.exports = {
  openRun,
  attemptsWith,
  recordCancellation,
  recordDiscarded,
  captureDocuments,
  syncRunPayload,
  currentRun,
  touchRun,
  closeRun,
  TERMINAL
};
