/**
 * PipelineRun — one coherent attempt at processing one round.
 *
 * The level the system was missing. A round is a version of the manuscript; a
 * run is one attempt at it; a StepExecution is one step inside that attempt.
 *
 * Before this, runs were numbered PER STEP — software run 3, materials run 1,
 * grounding run 2. Every number correct, and the set of them answering nothing:
 * no name for "the attempt that produced what I am looking at", and no ordering
 * across steps except timestamps. A user reading a result was reading a mix,
 * and the system could not say so because it had no word for it.
 *
 * ── What makes a run coherent ───────────────────────────────────────────────
 *
 * Not that everything in it happened at once. Selective restart means a run
 * legitimately contains steps executed minutes or days apart. What makes it
 * coherent is that the run DECLARES which execution each step contributes —
 * either one it created, or one carried over from its parent by link. See
 * PipelineRunStep.
 *
 * ── One operation ───────────────────────────────────────────────────────────
 *
 * Creating a submission, retrying a step, restarting a selection, uploading a
 * new document and replaying an old run are the same operation with a different
 * set of steps to re-run and a different rule for which inputs to inherit.
 * Retry and restart stop being separate mechanisms; `cause` is what tells them
 * apart afterwards.
 */

const { DataTypes } = require('sequelize');

/**
 * Why a run exists.
 *
 * A plain string column rather than a Postgres enum: the set is closed today
 * and will not stay closed, and an enum cannot have a value removed.
 */
const CAUSES = Object.freeze({
  CREATE_SUBMISSION: 'create_submission',
  RETRY: 'retry',
  RESTART: 'restart',
  NEW_DOCUMENT: 'new_document',
  REPLAY: 'replay'
});

/**
 * The pipeline's structural version.
 *
 * Bumped BY HAND when the structure changes in a way that makes an older run
 * unreadable by today's code — a step removed, a dependency inverted. Not
 * bumped for a new module or a prompt change: recording that something changed
 * is not the same as declaring old runs invalid, and conflating the two turns
 * every deploy into a history wipe. Provenance is `appVersion`'s job.
 */
const PIPELINE_VERSION = 1;

module.exports = (sequelize) => {
  const PipelineRun = sequelize.define('PipelineRun', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id',
      references: { model: 'submissions', key: 'id' }
    },
    round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

    /** 1-based per (submission, round). Allocated inside the INSERT. */
    runNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'run_number' },

    cause: {
      type: DataTypes.STRING(32),
      allowNull: false,
      validate: { isIn: [Object.values(CAUSES)] }
    },
    /** Null when nobody asked — the reconciler, an automatic cascade. */
    causedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'caused_by_user_id',
      references: { model: 'users', key: 'id' }
    },
    /** What this run was derived from. Null for the first run of a round. */
    parentRunId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'parent_run_id',
      references: { model: 'pipeline_runs', key: 'id' }
    },

    /**
     * `superseded` is a real state, not an oversight. A run replaced before it
     * finished is neither complete nor abandoned, and without the state its
     * status stays a lie for ever.
     */
    status: {
      type: DataTypes.ENUM('running', 'paused', 'complete', 'superseded'),
      allowNull: false,
      defaultValue: 'running'
    },

    /**
     * The pipeline as it stood when this run was created: the step list, each
     * step's dependencies and required set, and each step's config state.
     *
     * Not redundant with a StepExecution's `config`. That is written when a
     * module FINISHES, so a step that never ran has none — on a blocked round,
     * 1 of 12 steps carries a config record. Without this, "was software
     * detection switched off during run 2" is unanswerable exactly when it
     * matters, and "identifier detection is absent from this run" cannot be
     * told apart from "identifier detection did not exist yet".
     */
    shape: { type: DataTypes.JSONB, allowNull: true },

    pipelineVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: PIPELINE_VERSION,
      field: 'pipeline_version'
    },
    /** Provenance only. Never read to decide whether a run can be understood. */
    appVersion: { type: DataTypes.STRING(64), allowNull: true, field: 'app_version' },

    completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' }
  }, {
    tableName: 'pipeline_runs',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['submission_id', 'round', 'run_number'] },
      { fields: ['submission_id', 'round'] },
      { fields: ['parent_run_id'] }
    ]
  });

  /**
   * Open a run, allocating its number inside the INSERT.
   *
   * Computed in the statement rather than read-then-written, so two callers
   * cannot both see max=2 and both write run 3. The UNIQUE index is the
   * backstop: a bug surfaces as an error instead of as two runs wearing the
   * same number, which is the failure mode that is impossible to notice.
   *
   * @param {object} attrs
   * @param {string} attrs.submissionId
   * @param {number} attrs.round
   * @param {string} attrs.cause - one of CAUSES
   * @param {string} [attrs.causedByUserId]
   * @param {string} [attrs.parentRunId]
   * @param {object} [attrs.shape]
   * @param {string} [attrs.appVersion]
   * @param {object} [options] - `transaction`
   * @returns {Promise<PipelineRun>}
   */
  PipelineRun.open = async function(attrs, options = {}) {
    const [rows] = await sequelize.query(`
      INSERT INTO "pipeline_runs" (
        id, submission_id, round, run_number, cause, caused_by_user_id,
        parent_run_id, status, shape, pipeline_version, app_version,
        created_at, updated_at
      )
      SELECT
        gen_random_uuid(), :submissionId, :round,
        COALESCE(MAX(r.run_number), 0) + 1,
        :cause, :causedByUserId, :parentRunId,
        'running'::"enum_pipeline_runs_status",
        CAST(:shape AS JSONB), :pipelineVersion, :appVersion,
        NOW(), NOW()
      FROM "pipeline_runs" r
      WHERE r.submission_id = :submissionId AND r.round = :round
      RETURNING id
    `, {
      replacements: {
        submissionId: attrs.submissionId,
        round: attrs.round ?? 1,
        cause: attrs.cause,
        causedByUserId: attrs.causedByUserId || null,
        parentRunId: attrs.parentRunId || null,
        shape: attrs.shape ? JSON.stringify(attrs.shape) : null,
        pipelineVersion: attrs.pipelineVersion ?? PIPELINE_VERSION,
        appVersion: attrs.appVersion || null
      },
      transaction: options.transaction
    });

    return PipelineRun.findByPk(rows[0].id, { transaction: options.transaction });
  };

  /**
   * The newest run of a round — the one the submission is currently living in.
   *
   * @param {string} submissionId
   * @param {number} round
   * @param {object} [options] - `transaction`
   * @returns {Promise<PipelineRun|null>}
   */
  PipelineRun.current = async function(submissionId, round, options = {}) {
    return PipelineRun.findOne({
      where: { submissionId, round },
      order: [['runNumber', 'DESC']],
      transaction: options.transaction
    });
  };

  PipelineRun.CAUSES = CAUSES;
  PipelineRun.PIPELINE_VERSION = PIPELINE_VERSION;

  return PipelineRun;
};

module.exports.CAUSES = CAUSES;
module.exports.PIPELINE_VERSION = PIPELINE_VERSION;
