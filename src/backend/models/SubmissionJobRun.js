/**
 * SubmissionJobRun — one row per run of one pipeline step.
 *
 * `submission_jobs` holds ONE row per (submission, jobType, round), reused on
 * every re-run: it describes the CURRENT run and the pipeline reads it. This
 * table is the history beside it — every run that has ever been started,
 * including the ones that produced nothing.
 *
 * History must never be written as extra `submission_jobs` rows.
 * `getForSubmission` keeps the newest row per job type, so a second row hides
 * the pipeline's own and the advancement that should follow lands on the wrong
 * one. That is the fault that shipped a Generated KRT with 98 author rows and
 * zero detections.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SubmissionJobRun = sequelize.define('SubmissionJobRun', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
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

    /** 1-based, per (submission, jobType, round). Allocated at enqueue. */
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
    /** pg-boss attempts WITHIN this run. A retry is not a new run. */
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'retry_count' },

    counts: { type: DataTypes.JSONB, allowNull: true },
    // The payload. Nullable on purpose — the record above is small and kept
    // forever; this can be pruned without losing the history.
    result: { type: DataTypes.JSONB, allowNull: true },
    logs: { type: DataTypes.JSONB, allowNull: true },
    inputs: { type: DataTypes.JSONB, allowNull: true },
    s3Prefix: { type: DataTypes.TEXT, allowNull: true, field: 's3_prefix' }
  }, {
    tableName: 'submission_job_runs',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['submission_job_id', 'run_number'] },
      { fields: ['submission_id', 'round', 'job_type'] },
      { fields: ['triggered_by_user_id'] }
    ]
  });

  /**
   * The runs of one step, newest first.
   *
   * @param {string} submissionId
   * @param {string} jobType
   * @param {number} round
   * @param {object} [options] - `metadataOnly` omits the heavy JSONB columns,
   *   which is what a run LIST wants: the payloads are megabytes and the list
   *   shows none of them.
   * @returns {Promise<SubmissionJobRun[]>}
   */
  SubmissionJobRun.listForStep = async function(submissionId, jobType, round, { metadataOnly = false } = {}) {
    const where = { submissionId, jobType };
    if (round !== undefined) where.round = round;
    return SubmissionJobRun.findAll({
      where,
      order: [['runNumber', 'DESC']],
      ...(metadataOnly
        ? { attributes: { exclude: ['result', 'logs', 'inputs'] } }
        : {})
    });
  };

  return SubmissionJobRun;
};
