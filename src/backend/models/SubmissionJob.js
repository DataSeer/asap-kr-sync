/**
 * SubmissionJob Model
 * Tracks background job status for all async processes per submission
 */

const { DataTypes, Op } = require('sequelize');

module.exports = (sequelize) => {
  const SubmissionJob = sequelize.define('SubmissionJob', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id',
      references: {
        model: 'submissions',
        key: 'id'
      }
    },
    jobType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'job_type'
    },
    status: {
      type: DataTypes.ENUM('waiting', 'pending_input', 'queued', 'processing', 'complete', 'failed', 'cancelled'),
      allowNull: false,
      defaultValue: 'queued'
    },
    pgBossJobId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'pg_boss_job_id'
    },
    referenceId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'reference_id'
    },
    /**
     * Who asked for this step to run.
     *
     * NOT the submission's owner — a curator re-running one detector on an
     * author's manuscript is the trigger, not the owner. Set when the pipeline
     * is started, when a step is re-queued, and when a parked step is advanced
     * by hand; a step the orchestrator advances on its own keeps whoever
     * started the round. NULL means no user was involved, or the row predates
     * the column.
     */
    triggeredByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'triggered_by_user_id',
      references: {
        model: 'users',
        key: 'id'
      }
    },
    result: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'error_message'
    },
    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'retry_count'
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    logs: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: []
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'started_at'
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'completed_at'
    }
  }, {
    tableName: 'submission_jobs',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['submission_id', 'round'] },
      { fields: ['submission_id', 'job_type', 'round'] }
    ]
  });

  /**
   * Mark job as pending user input (dependencies done but auto-advance condition not met)
   * @param {object} result - Optional context about why input is needed
   */
  SubmissionJob.prototype.markPendingInput = async function(result = null) {
    this.status = 'pending_input';
    if (result) this.result = result;
    return this.save();
  };

  /**
   * Mark job as processing
   * @param {number} retryCount - Current retry attempt (from pg-boss)
   */
  SubmissionJob.prototype.markProcessing = async function(retryCount = 0) {
    // Same reload-then-check as markComplete, and for the same reason: the
    // worker's instance was loaded before the handler started, so a cancel that
    // landed in between is invisible in memory. Without this, a worker that had
    // already fetched a job wrote `processing` OVER the cancel — and then
    // markComplete's own guard saw `processing`, not `cancelled`, and completed
    // the job the user had stopped.
    await this.reload();
    if (this.status === 'cancelled') return this;
    this.status = 'processing';
    this.startedAt = new Date();
    this.retryCount = retryCount;
    this.errorMessage = null; // Clear previous error on retry
    return this.save();
  };

  /**
   * Mark job as complete with result data (merged with existing result)
   * @param {object} result - Standardized result: { status, counts, timing, data, files }
   */
  SubmissionJob.prototype.markComplete = async function(result = null) {
    // Reload from DB to pick up any result changes made by the service
    // (the service may use a different instance via getLatest())
    await this.reload();
    // Never resurrect a cancelled job: if the user cancelled this run while a
    // worker had already dequeued this job, honor the cancel and drop the
    // now-irrelevant result rather than flipping it back to 'complete'.
    if (this.status === 'cancelled') return this;
    this.status = 'complete';
    if (result) {
      this.result = { ...(this.result || {}), ...result };
    }
    this.changed('result', true);
    this.completedAt = new Date();
    return this.save();
  };

  /**
   * Mark job as failed with error message
   * @param {string} errorMessage
   */
  SubmissionJob.prototype.markFailed = async function(errorMessage) {
    // A job the user cancelled must stay cancelled even if the worker that was
    // mid-flight ultimately errors — the failure is a consequence of the cancel,
    // not a real error to surface or retry.
    //
    // The reload is what makes the guard work. Checking the in-memory status
    // asks the copy this worker loaded before the handler ran, which still says
    // `processing`; the row was overwritten with `failed`, the user saw a
    // failure for something they had cancelled, and — if it was the round's
    // only cancelled row — `isRoundCancelled` flipped back to false, which
    // un-suppressed the retry and restarted the external work they had stopped.
    await this.reload();
    if (this.status === 'cancelled') return this;
    this.status = 'failed';
    this.errorMessage = errorMessage;
    this.completedAt = new Date();
    return this.save();
  };

  /**
   * Record an error on an attempt that pg-boss is going to retry.
   *
   * `failed` is a TERMINAL state to everything that reads these rows, and using
   * it for a retryable error strands the pipeline. The orchestrator treats a
   * dependency as done when it is `complete` **or** `failed`, so a sweep landing
   * in the retry backoff window read the dependency as finished, evaluated the
   * dependent's gate against a result that was not there yet, and parked it in
   * `pending_input`. Nothing revisits `pending_input`: when the retry then
   * succeeded, the advance found the dependent no longer `waiting` and did
   * nothing. Only a manual advance recovered it. (Observed as PDF Analysis stuck
   * behind a DAS extraction that had in fact succeeded on its second attempt.)
   *
   * So the row stays `processing` — which is true, the job is still in flight —
   * and carries the last error for the UI to show alongside its attempt counter.
   *
   * @param {string} errorMessage
   */
  SubmissionJob.prototype.markRetrying = async function(errorMessage) {
    await this.reload();   // see markFailed: the in-memory status is stale here
    if (this.status === 'cancelled') return this;
    this.status = 'processing';
    this.errorMessage = errorMessage;
    this.completedAt = null;
    return this.save();
  };

  /**
   * Mark a job as cancelled by the user (terminal). Only applied to jobs that
   * had NOT started — a job already 'processing' is left to finish and record
   * its real done/failed status (see the cancel controller).
   */
  SubmissionJob.prototype.markCancelled = async function() {
    this.status = 'cancelled';
    this.completedAt = new Date();
    return this.save();
  };

  /**
   * Was this (submission, round) cancelled by the user? True iff any of its jobs
   * is in the terminal 'cancelled' state. This is the pipeline's run-level
   * cancel signal: the orchestrator won't advance new steps and workers skip
   * retries once it's true.
   * @param {string} submissionId
   * @param {number} round
   * @returns {Promise<boolean>}
   */
  SubmissionJob.isRoundCancelled = async function(submissionId, round) {
    // Use the latest row per job type (getForSubmission dedupes newest-first) so
    // the signal reflects the CURRENT state: a restart replaces a cancelled job
    // with a fresh row, which must clear this flag even though the old cancelled
    // row still exists in history.
    const jobs = await SubmissionJob.getForSubmission(submissionId, round);
    return jobs.some(j => j.status === 'cancelled');
  };

  /**
   * Get latest job per job type for a submission + round
   * @param {string} submissionId
   * @param {number} round
   * @returns {Promise<Array>} Latest job per type
   */
  SubmissionJob.getForSubmission = async function(submissionId, round) {
    const where = { submissionId };
    if (round !== undefined) {
      where.round = round;
    }

    // Two queries on purpose. `result` is JSONB and holds a whole detection —
    // one submission in dev carries 2.3 MB across its rows — and the jobs
    // endpoint is polled every few seconds by every open tab. Selecting every
    // row and then dropping all but the newest per type read (and shipped from
    // Postgres) every superseded payload on every poll.
    //
    // Pass 1 is metadata only, so it stays small no matter what the runs hold.
    const index = await SubmissionJob.findAll({
      where,
      attributes: ['id', 'jobType', 'createdAt'],
      order: [['createdAt', 'DESC']],
      raw: true
    });

    const latestIdByType = new Map();
    for (const row of index) {
      if (!latestIdByType.has(row.jobType)) {
        latestIdByType.set(row.jobType, row.id);
      }
    }
    if (latestIdByType.size === 0) return [];

    // Pass 2 fetches only those rows, as full instances — callers call
    // markComplete/markFailed on what comes back, so these cannot be `raw`.
    const jobs = await SubmissionJob.findAll({
      where: { id: Array.from(latestIdByType.values()) },
      order: [['createdAt', 'DESC']]
    });
    return jobs;
  };

  /**
   * Get the latest job of a specific type for a submission
   * @param {string} submissionId
   * @param {string} jobType
   * @param {number} round
   * @returns {Promise<SubmissionJob|null>}
   */
  SubmissionJob.getLatest = async function(submissionId, jobType, round) {
    const where = { submissionId, jobType };
    if (round !== undefined) {
      where.round = round;
    }
    return SubmissionJob.findOne({
      where,
      order: [['createdAt', 'DESC']]
    });
  };

  return SubmissionJob;
};
