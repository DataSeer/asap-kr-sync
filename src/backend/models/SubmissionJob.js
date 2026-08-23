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
     * when" and a boolean cannot answer it.
     *
     * ── It lives on the EXECUTION, not here ─────────────────────────────────
     *
     * It used to be two columns on this row, cleared on retry and on restart
     * because the decision was about one run's issue and not about the step.
     * Three places had to remember to clear them, and `runAllProcesses` — the
     * one that re-runs everything — did not: a decision made about run 1's
     * failure silently waved through run 2's.
     *
     * A decision now belongs to the execution it was made about. A re-executed
     * step gets a new execution, which was never decided about, so there is no
     * field left to forget to clear; a carried-over step keeps the same
     * execution and therefore the same decision, which is also right — you kept
     * the result, you kept what was decided about it.
     *
     * `getForSubmission` attaches it as `job.decision`, so the orchestrator's
     * hot path reads one object rather than issuing a query per step.
     */
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
     * How many times this step has EXECUTED in this round.
     *
     * Denormalised from `step_executions` so the panel and the report can say
     * so without an aggregate on a table polled every few seconds. Written by
     * run-history's openRun — which silently did nothing until this attribute
     * existed, because Sequelize drops unknown fields from `update` and the
     * history writes are deliberately guarded.
     *
     * Zero, not one. It used to be SET to the step's own run number, so a
     * default of 1 meant "the first run"; it is INCREMENTED now, and the same
     * default made a step that had run once report two. A step that has not run
     * has executed zero times, which is also the honest answer for a step a run
     * has not reached.
     *
     * NOT the run number. A run can carry a step over rather than re-executing
     * it, so "which run is this" and "how many times has this step run" are
     * different questions, and this answers the second.
     */
    runCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    // worker had already dequeued this job, honour the cancel rather than
    // flipping it back to 'complete'.
    //
    // But the answer is RECORDED before it is dropped. The external call could
    // not be stopped — it completed and was billed — so discarding it silently
    // means the money was spent and the record says nothing. This is what makes
    // "did we pay for something we threw away" answerable.
    if (this.status === 'cancelled') {
      await runHistory().recordDiscarded(this, {
        outcome: result?.service?.outcome?.state || 'done',
        counts: result?.counts ?? null
      });
      return this;
    }
    this.status = 'complete';
    // A step that succeeded on its third attempt used to carry the second
    // attempt's error into its record, because nothing ever cleared it — so the
    // module page showed a completed run beside a red error string. The
    // attempts array is where that error belongs now, and it is there.
    this.errorMessage = null;
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
   * Store what this step produced, before it is marked complete.
   *
   * Nine services need this — downstream steps read a module's output through
   * `getLatest`, not through the execution — and all nine used to do it by hand:
   * read the row, spread `result`, set `changed`, save. Identical four-line
   * blocks, which is how they all came to share one bug.
   *
   * ── The bug ─────────────────────────────────────────────────────────────
   *
   * None of them checked for a cancel. `markComplete` did, and refused to
   * record a cancelled step's answer — but this runs BEFORE it, so the answer
   * the user threw away landed on the row anyway, and every page rendered it as
   * the step's result beside a status line saying the run was cancelled. Seen
   * live: software detection cancelled mid-call, 32 items on screen.
   *
   * The reload is what makes the check work: the worker's instance was loaded
   * before the handler started, so a cancel that landed in between is invisible
   * in memory — the same reason markComplete reloads.
   *
   * @param {object} data - the module's `data` payload
   * @returns {Promise<SubmissionJob>}
   */
  SubmissionJob.prototype.persistData = async function(data) {
    await this.reload();
    if (this.status === 'cancelled') return this;
    this.result = { ...(this.result || {}), data };
    this.changed('result', true);
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
    if (this.status === 'cancelled') {
      // A failure that arrived after the cancel is still something that
      // happened, and something that was paid for. See markComplete.
      await runHistory().recordDiscarded(this, { outcome: 'fail', error: errorMessage });
      return this;
    }
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
    await runHistory().touchRun(
      this,
      { retryCount: this.retryCount ?? 0, externalError: errorMessage },
      // This delivery is over and it failed. Recorded now rather than at the
      // end: pg-boss hands the next delivery a fresh attempt store, so anything
      // still sitting in this one would be lost.
      { ok: false, error: errorMessage, delivery: (this.retryCount ?? 0) + 1 }
    );
    return saved;
  };

  /**
   * Mark a job as cancelled by the user. Terminal.
   *
   * Applied to a RUNNING step as well as a waiting one. A cancel interrupts:
   * the execution becomes `cancelled`, is unusable, and the step must be re-run.
   * It used to leave a `processing` job alone to finish and record its real
   * status, which meant pressing Cancel on the one thing actually burning money
   * did nothing a user could see.
   *
   * What cannot be interrupted is the external call itself — the promise is
   * abandoned, the call completes, and it is billed. So the answer, when it
   * arrives, is recorded as discarded rather than dropped: see markComplete.
   *
   * @param {string} [userId] - who stopped it
   */
  SubmissionJob.prototype.markCancelled = async function(userId = null) {
    this.status = 'cancelled';
    this.completedAt = new Date();
    const saved = await this.save();
    // A cancelled run is still a run: "this was attempted and stopped" is
    // exactly the kind of thing an audit asks about.
    await runHistory().closeRun(this);
    await runHistory().recordCancellation(this, { userId });
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

    await attachDecisions(jobs, submissionId, round);
    return jobs;
  };

  /**
   * Attach each step's decision and cancellation, from the run the round is in.
   *
   * Done HERE rather than in each caller, deliberately. A caller that forgot
   * would not see an error — it would see a step with no decision, and would
   * hold the pipeline for a question somebody has already answered. That is a
   * failure by absence, which is the kind nobody notices.
   *
   * One query, through the run's MEMBERSHIP rather than the executions' own
   * `pipeline_run_id`: a carried-over execution belongs to the run that created
   * it, and looking it up by that column would drop its decision the moment
   * anything else was restarted. Going through membership is also what makes
   * "decisions carry over" true without any code saying so.
   *
   * The cancellation rides along on the same query: the module page reads a
   * step's state from the jobs payload, so a cancelled step could otherwise say
   * "cancelled" without saying by whom, or that a call it had paid for landed
   * afterwards and was thrown away.
   *
   * Never throws. A decision that could not be read holds the pipeline, which is
   * the conservative outcome — the question gets asked again rather than
   * silently answered.
   *
   * @param {object[]} jobs - mutated in place
   * @param {string} submissionId
   * @param {number} round
   */
  async function attachDecisions(jobs, submissionId, round) {
    if (round === undefined || !jobs.length) return;
    try {
      const { sequelize: db } = require('./index');
      const [rows] = await db.query(`
        SELECT prs.job_type, se.decision, se.cancelled_by_user_id, se.discarded
        FROM "pipeline_run_steps" prs
        JOIN "step_executions" se ON se.id = prs.step_execution_id
        JOIN "pipeline_runs" pr ON pr.id = prs.pipeline_run_id
        WHERE pr.submission_id = :submissionId
          AND pr.round = :round
          AND pr.run_number = (
            SELECT MAX(run_number) FROM "pipeline_runs"
            WHERE submission_id = :submissionId AND round = :round
          )
      `, { replacements: { submissionId, round } });

      const byType = new Map(rows.map((row) => [row.job_type, row]));
      for (const job of jobs) {
        const found = byType.get(job.jobType);
        job.decision = found?.decision || null;
        job.cancelledByUserId = found?.cancelled_by_user_id || null;
        job.discarded = found?.discarded || [];
      }
    } catch (error) {
      require('../utils/logger').error('Could not read this round\'s decisions', {
        submissionId, round, error: error.message
      });
    }
  }

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
