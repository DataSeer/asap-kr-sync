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
 * Open a run for a step that has just been enqueued.
 *
 * `run_number` is allocated in the INSERT itself, so two callers cannot read
 * the same maximum and both write run 3. The UNIQUE(submission_job_id,
 * run_number) index is the backstop: a bug surfaces as an error rather than as
 * two runs wearing the same number.
 *
 * @param {object} job - the SubmissionJob row being enqueued
 * @param {object} [opts]
 * @param {string} [opts.userId] - who asked, when a person did
 * @param {string} [opts.triggerKind] - 'manual' | 'pipeline' | 'reconciler'
 * @returns {Promise<object|null>} the new run, or null if recording failed
 */
async function openRun(job, { userId = null, triggerKind = null } = {}) {
  return guarded('opening a run', async () => {
    const { SubmissionJobRun, SubmissionJob, sequelize } = require('../../models');

    const [rows] = await sequelize.query(`
      INSERT INTO "submission_job_runs" (
        id, submission_job_id, submission_id, job_type, round, run_number,
        status, triggered_by_user_id, trigger_kind, s3_prefix, created_at, updated_at
      )
      SELECT
        gen_random_uuid(), :jobId, :submissionId, :jobType, :round,
        COALESCE(MAX(r.run_number), 0) + 1,
        'queued'::"enum_submission_job_runs_status", :userId, :triggerKind,
        -- Where this run's artefacts will be written, recorded in the same
        -- statement that decides the number they are keyed by. Runs from before
        -- run history keep their old jobs/<type>/<jobRowId> prefix, which is
        -- why this is stored per run rather than derived from the job type.
        'jobs/' || :jobType || '/run-' || (COALESCE(MAX(r.run_number), 0) + 1),
        NOW(), NOW()
      FROM "submission_job_runs" r
      WHERE r.submission_job_id = :jobId
      RETURNING id, run_number
    `, {
      replacements: {
        jobId: job.id,
        submissionId: job.submissionId,
        jobType: job.jobType,
        round: job.round ?? 1,
        userId: userId || null,
        triggerKind: triggerKind || null
      }
    });

    const created = rows[0];
    // Denormalised onto the job row so the panel can say "run 3" without an
    // aggregate on a table polled every few seconds.
    await SubmissionJob.update(
      { runCount: created.run_number },
      { where: { id: job.id } }
    );

    return SubmissionJobRun.findByPk(created.id);
  });
}

/**
 * The run currently open for a step: the highest-numbered one.
 *
 * @param {string} submissionJobId
 * @returns {Promise<object|null>}
 */
async function currentRun(submissionJobId) {
  const { SubmissionJobRun } = require('../../models');
  return SubmissionJobRun.findOne({
    where: { submissionJobId },
    order: [['runNumber', 'DESC']]
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
 * @param {object} fields - SubmissionJobRun attributes
 */
async function touchRun(job, fields) {
  return guarded('updating a run', async () => {
    const run = await currentRun(job.id);
    if (!run) return null;
    return run.update(fields);
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
      counts: job.result?.counts ?? null,
      result: job.result ?? null,
      logs: job.logs ?? null
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
    return run.update({
      result: job.result ?? null,
      logs: job.logs ?? null,
      counts: job.result?.counts ?? null
    });
  });
}

module.exports = {
  openRun,
  syncRunPayload,
  currentRun,
  touchRun,
  closeRun,
  TERMINAL
};
