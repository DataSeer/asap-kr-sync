/**
 * SubmissionJob Model
 * Tracks background job status for all async processes per submission
 */

const { DataTypes, Op } = require('sequelize');
const tokenUsage = require('../utils/token-usage');

/**
 * Lazily required: the history service requires the models back, and resolving
 * that at module load is a cycle. Every call is wrapped so a history failure
 * logs and lets the run continue — see run-history.service.
 */
const runHistory = () => require('../services/queue/run-history.service');

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
      type: DataTypes.ENUM('waiting', 'pending_input', 'queued', 'processing', 'complete', 'failed', 'cancelled', 'skipped'),
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
     * is started, when a step is re-queued (and on everything downstream that
     * re-run restarts), and when a parked step is advanced by hand. A step the
     * orchestrator advances on its own — a worker finishing, or the periodic
     * reconciler — keeps the credit already there.
     *
     * Every HTTP route that starts work is authenticated and passes its
     * `req.userId`, so NULL means the row predates this column, a script drove
     * the service layer directly, or no user was ever involved.
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
    /**
     * When somebody decided to carry on despite this step's issue.
     *
     * An issue — a failure, a partial, or a run that completed producing nothing
     * usable — holds everything downstream at `waiting` until this is set. The
     * alternative, which is what used to happen, is a Generated KRT built from
     * four detectors instead of five with nothing anywhere saying so.
     *
     * Timestamped and attributed rather than a boolean, because the question is
     * "who decided this report would be built without software detection, and
     * when" and a boolean cannot answer it. Cleared on retry and on restart: the
     * decision was about one run's issue, not about the step.
     */
    issueAcknowledgedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'issue_acknowledged_at'
    },
    issueAcknowledgedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'issue_acknowledged_by_user_id',
      references: { model: 'users', key: 'id' }
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
    /**
     * How many times this step has been run in this round.
     *
     * Denormalised from `submission_job_runs` so the panel and the jobs list can
     * say "run 3" without an aggregate on a table polled every few seconds.
     * Written by run-history's openRun — which silently did nothing until this
     * attribute existed, because Sequelize drops unknown fields from `update`
     * and the history writes are deliberately guarded.
     */
    runCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      field: 'run_count'
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
    const saved = await this.save();
    await runHistory().touchRun(this, { status: 'processing', startedAt: this.startedAt, retryCount });
    return saved;
  };

  /**
   * Mark job as complete with result data (merged with existing result)
   * @param {object} result - Standardized result: { status, counts, timing, data, files }
   */
  /**
   * The step will not run: something it required produced nothing.
   *
   * Not `cancelled` — that word means a person stopped it, and a report has to
   * tell "skipped because the conversion produced no text" apart from "stopped
   * deliberately". Not left `waiting` either: `allProcessesFinished` would never
   * become true and the submission's own Continue button would stay disabled,
   * trapping the user in the step with no way out.
   *
   * Records WHAT was missing, because "skipped" without a cause is the same
   * silence this whole mechanism exists to remove.
   *
   * @param {string[]} missing - the required dependencies that produced nothing
   */
  SubmissionJob.prototype.markSkipped = async function(missing = []) {
    await this.reload();
    if (['cancelled', 'complete'].includes(this.status)) return this;
    this.status = 'skipped';
    this.completedAt = new Date();
    this.result = { ...(this.result || {}), skipped: { missing, at: new Date().toISOString() } };
    this.changed('result', true);
    return this.save();
  };

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
    // What this run spent, read from the ambient tally rather than passed in by
    // each of the nine services that call a model. Here because this is the one
    // place every job's result is written, so a service added later reports its
    // usage without knowing this exists.
    //
    // Absent when no model was called: a row of zeroes on Markdown Convert
    // would be noise on every page it appears.
    const tokens = tokenUsage.current();
    if (tokens) this.result = { ...(this.result || {}), tokens };
    this.changed('result', true);
    this.completedAt = new Date();
    const saved = await this.save();
    await runHistory().closeRun(this);
    return saved;
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
    const saved = await this.save();
    await runHistory().closeRun(this);
    return saved;
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
    const saved = await this.save();
    // The SAME run, one attempt further in. Opening a new run here would count
    // a pg-boss retry as a user-visible re-run, which it is not.
    await runHistory().touchRun(this, { retryCount: this.retryCount ?? 0, externalError: errorMessage });
    return saved;
  };

  /**
   * Mark a job as cancelled by the user (terminal). Only applied to jobs that
   * had NOT started — a job already 'processing' is left to finish and record
   * its real done/failed status (see the cancel controller).
   */
  SubmissionJob.prototype.markCancelled = async function() {
    this.status = 'cancelled';
    this.completedAt = new Date();
    const saved = await this.save();
    // A cancelled run is still a run: "this was attempted and stopped" is
    // exactly the kind of thing an audit asks about.
    await runHistory().closeRun(this);
    return saved;
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
