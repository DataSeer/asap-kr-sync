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
      type: DataTypes.ENUM('waiting', 'pending_input', 'queued', 'processing', 'complete', 'failed'),
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
    this.status = 'failed';
    this.errorMessage = errorMessage;
    this.completedAt = new Date();
    return this.save();
  };

  /**
   * Mark a job as cancelled by the user. There is no dedicated 'cancelled' enum
   * value (the status type is a fixed Postgres ENUM), so we record it as a
   * terminal 'failed' with a stable sentinel message. The frontend recognizes
   * SubmissionJob.CANCELLED_MESSAGE to render it as "Cancelled" and to suppress
   * the failure toast.
   */
  SubmissionJob.prototype.markCancelled = async function() {
    this.status = 'failed';
    this.errorMessage = SubmissionJob.CANCELLED_MESSAGE;
    this.completedAt = new Date();
    return this.save();
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

    // Get all jobs for this submission/round, ordered newest first
    const allJobs = await SubmissionJob.findAll({
      where,
      order: [['createdAt', 'DESC']]
    });

    // Keep only the latest per job type
    const latestByType = new Map();
    for (const job of allJobs) {
      if (!latestByType.has(job.jobType)) {
        latestByType.set(job.jobType, job);
      }
    }

    return Array.from(latestByType.values());
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

  // Stable sentinel written to errorMessage when a job is cancelled by the user
  // (see markCancelled). Shared contract with the frontend, which matches on it.
  SubmissionJob.CANCELLED_MESSAGE = 'Cancelled by user';

  return SubmissionJob;
};
