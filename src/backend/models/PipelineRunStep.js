/**
 * PipelineRunStep — membership. What a run CONTAINS.
 *
 * A run holds one row per pipeline step, from the moment it is created. The row
 * exists before the step has done anything, because "this run contains software
 * detection, which has not started" is a fact the run has to be able to state —
 * a run that only lists what has finished cannot be read while it is running.
 *
 * ── Why membership is a link and not a copy ─────────────────────────────────
 *
 * Restarting one detector must not re-run the other eleven steps. So run N+1
 * legitimately contains executions that run N created, and it says so by
 * POINTING at them. Copying those rows instead would duplicate megabytes of
 * payload on every restart and create two records of one event that can drift
 * apart — and the whole point of this model is that there is one record of what
 * happened.
 *
 * `carriedOver` is what makes that visible rather than merely true. The UI must
 * always mark a carried-over step as carried over and name the run it came
 * from; it is what stops "why does this still say 14 items when I just re-ran
 * it", and the decision attached to a carried-over execution carries with it
 * for the same reason — you kept the execution, you kept what was decided about
 * it.
 *
 * ── Why RESTRICT ────────────────────────────────────────────────────────────
 *
 * Retention will eventually prune old executions. It may not do that by
 * silently emptying a run that still contains them: a run with holes in it is
 * worse than no run, because it still looks complete. The database refuses,
 * which turns a retention bug into an error instead of into missing history.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PipelineRunStep = sequelize.define('PipelineRunStep', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    pipelineRunId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'pipeline_run_id',
      references: { model: 'pipeline_runs', key: 'id' }
    },
    jobType: { type: DataTypes.STRING(50), allowNull: false, field: 'job_type' },

    /** Null until the step executes. */
    stepExecutionId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'step_execution_id',
      references: { model: 'step_executions', key: 'id' }
    },

    /** True when it points at an execution another run created. */
    carriedOver: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'carried_over'
    }
  }, {
    tableName: 'pipeline_run_steps',
    underscored: true,
    timestamps: true,
    indexes: [
      { unique: true, fields: ['pipeline_run_id', 'job_type'] },
      { fields: ['step_execution_id'] }
    ]
  });

  /**
   * Attach an execution to the step it belongs to in a run.
   *
   * Called when a step starts executing, so the membership row stops being a
   * placeholder. Deliberately an UPDATE of the existing row rather than an
   * upsert: a run's step list is fixed when the run is created, and a step
   * appearing in a run that never declared it means something went wrong
   * upstream — better as a missing link that can be found than as a row that
   * quietly materialises.
   *
   * @param {string} pipelineRunId
   * @param {string} jobType
   * @param {string} stepExecutionId
   * @param {object} [options] - `transaction`
   * @returns {Promise<number>} rows updated — 0 means the run never declared it
   */
  PipelineRunStep.attach = async function(pipelineRunId, jobType, stepExecutionId, options = {}) {
    const [updated] = await PipelineRunStep.update(
      { stepExecutionId, carriedOver: false },
      { where: { pipelineRunId, jobType }, transaction: options.transaction }
    );
    return updated;
  };

  /**
   * Every step of a run, in no particular order — the caller has PIPELINE for
   * that, and ordering here would encode the pipeline's shape in two places.
   *
   * @param {string} pipelineRunId
   * @returns {Promise<PipelineRunStep[]>}
   */
  PipelineRunStep.forRun = async function(pipelineRunId) {
    return PipelineRunStep.findAll({ where: { pipelineRunId } });
  };

  return PipelineRunStep;
};
