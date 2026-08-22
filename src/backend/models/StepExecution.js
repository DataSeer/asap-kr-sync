/**
 * StepExecution — one step of one pipeline run, actually doing work.
 *
 * The third of the four levels: a round is a version of the manuscript, a
 * PipelineRun is one coherent attempt at processing it, an execution is one
 * step inside that attempt, and an attempt (`attempts` below) is one try inside
 * the execution.
 *
 * `submission_jobs` holds ONE row per (submission, jobType, round), reused on
 * every re-run: it is what the SCHEDULER needs — live status, queue id — and
 * the pipeline reads it. This table is the record beside it: every execution
 * that has ever been started, including the ones that produced nothing.
 *
 * History must never be written as extra `submission_jobs` rows.
 * `getForSubmission` keeps the newest row per job type, so a second row hides
 * the pipeline's own and the advancement that should follow lands on the wrong
 * one. That is the fault that shipped a Generated KRT with 98 author rows and
 * zero detections.
 *
 * ── Immutability ────────────────────────────────────────────────────────────
 *
 * Once an execution finishes, its OUTPUT is frozen. Its DISPOSITION — the
 * decision attached to it, its membership in later runs — is append-only. The
 * distinction matters because a decision is recorded after the execution ends,
 * so a literal "nothing may be written" rule would be broken by the first thing
 * the system does with a failed step.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const StepExecution = sequelize.define('StepExecution', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    /**
     * The run that CREATED this execution — never null.
     *
     * A pipeline run is meant to be a complete description of one attempt,
     * reachable without reading the submission's current state. An execution
     * belonging to no run cannot be reached that way: present in the table,
     * absent from every screen built on the model. Note that this is not "the
     * runs this execution appears in" — a carried-over execution appears in
     * several, and that is what `pipeline_run_steps` is for.
     */
    pipelineRunId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'pipeline_run_id',
      references: { model: 'pipeline_runs', key: 'id' }
    },
    submissionJobId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_job_id',
      references: { model: 'submission_jobs', key: 'id' }
    },
    /**
     * Denormalised from the job row, so history can be read without a join —
     * "every run this person started", "every run of round 1" — and so a run
     * remains meaningful on its own.
     */
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id',
      references: { model: 'submissions', key: 'id' }
    },
    jobType: { type: DataTypes.STRING(50), allowNull: false, field: 'job_type' },
    round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    /**
     * 1-based, per (submission, jobType, round). Allocated at enqueue.
     *
     * Transitional. The pipeline run now numbers the attempt, and numbering the
     * step again inside it is the ambiguity this model was changed to remove —
     * "run 3" meant two different things depending on which screen asked. Kept
     * only until the history reads move onto pipeline runs.
     */
    runNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'run_number' },

    status: {
      type: DataTypes.ENUM('waiting', 'pending_input', 'queued', 'processing', 'complete', 'failed', 'cancelled', 'skipped'),
      allowNull: false,
      defaultValue: 'queued'
    },

    // The service snapshot, flattened so it can be filtered on. 'partial' is a
    // real outcome: the run produced rows AND an engine behind it failed.
    outcomeState: { type: DataTypes.STRING(16), allowNull: true, field: 'outcome_state' },
    outcomeSource: { type: DataTypes.STRING(16), allowNull: true, field: 'outcome_source' },
    failReason: { type: DataTypes.TEXT, allowNull: true, field: 'fail_reason' },
    externalError: { type: DataTypes.TEXT, allowNull: true, field: 'external_error' },

    /** Who asked for this run. NOT the submission's owner. */
    triggeredByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'triggered_by_user_id',
      references: { model: 'users', key: 'id' }
    },
    /**
     * How it was started: 'manual' (someone clicked), 'pipeline' (a step
     * finished and released this one), 'reconciler' (the periodic sweep).
     * Only 'manual' is a decision by a person — the distinction the credit
     * rules already depend on, now kept rather than recomputed.
     */
    triggerKind: { type: DataTypes.STRING(16), allowNull: true, field: 'trigger_kind' },

    startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
    /** Stored, not derived: a later purge of timestamps must not take it too. */
    durationMs: { type: DataTypes.INTEGER, allowNull: true, field: 'duration_ms' },
    /** pg-boss attempts WITHIN this execution. A retry is not a new run. */
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'retry_count' },

    /**
     * Every try, at both retry layers: `[{ n, at, ok, error, httpStatus, engine }]`.
     *
     * `retryCount` counts pg-boss re-deliveries and nothing else, and the error
     * text is overwritten each time — so "the first two attempts returned 529,
     * then it succeeded" is unanswerable, which is exactly the difference
     * between a flaky upstream and a broken one.
     */
    attempts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },

    /**
     * The config as THIS execution saw it.
     *
     * May differ from the run's `shape`: the shape is recorded when the run is
     * created, and an admin can change a module's settings between then and the
     * step actually running.
     */
    config: { type: DataTypes.JSONB, allowNull: true },

    /**
     * `{ at, byUserId, choice }` — what was decided about this execution.
     *
     * Lives here rather than on the job row, which is what makes it carry over
     * with the result it is about, and what removes the field that had to be
     * cleared in three places on every re-run. A new execution was never
     * decided about, so there is nothing to forget to clear.
     */
    decision: { type: DataTypes.JSONB, allowNull: true },

    /** `{ missing: [jobType] }` — what this step needed and did not get. */
    skipReason: { type: DataTypes.JSONB, allowNull: true, field: 'skip_reason' },

    cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
    cancelledByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'cancelled_by_user_id',
      references: { model: 'users', key: 'id' }
    },
    /**
     * A response that arrived after the cancel and was thrown away.
     *
     * Cancelling forces the status to `cancelled`, but a call already in flight
     * still lands. Dropping it silently means the money was spent and the record
     * says nothing; this says what came back and that nothing was done with it.
     */
    discarded: { type: DataTypes.JSONB, allowNull: true },

    counts: { type: DataTypes.JSONB, allowNull: true },
    // The payload. Nullable on purpose — the record above is small and kept
    // forever; this can be pruned without losing the history.
    result: { type: DataTypes.JSONB, allowNull: true },
    logs: { type: DataTypes.JSONB, allowNull: true },
    inputs: { type: DataTypes.JSONB, allowNull: true },
    s3Prefix: { type: DataTypes.TEXT, allowNull: true, field: 's3_prefix' }
  }, {
    tableName: 'step_executions',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['submission_job_id', 'run_number'] },
      { fields: ['submission_id', 'round', 'job_type'] },
      { fields: ['pipeline_run_id'] },
      { fields: ['triggered_by_user_id'] }
    ]
  });

  /**
   * The executions of one step, newest first.
   *
   * @param {string} submissionId
   * @param {string} jobType
   * @param {number} round
   * @param {object} [options] - `metadataOnly` omits the heavy JSONB columns,
   *   which is what an execution LIST wants: the payloads are megabytes and the list
   *   shows none of them.
   * @returns {Promise<StepExecution[]>}
   */
  StepExecution.listForStep = async function(submissionId, jobType, round, { metadataOnly = false } = {}) {
    const where = { submissionId, jobType };
    if (round !== undefined) where.round = round;
    return StepExecution.findAll({
      where,
      order: [['runNumber', 'DESC']],
      ...(metadataOnly
        ? { attributes: { exclude: ['result', 'logs', 'inputs'] } }
        : {})
    });
  };

  return StepExecution;
};
