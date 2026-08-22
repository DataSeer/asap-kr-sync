'use strict';

/**
 * The last of the per-step run model.
 *
 * Three columns whose jobs have moved, and one index replaced by a better
 * statement of the same invariant.
 *
 * ── `step_executions.run_number` ────────────────────────────────────────────
 *
 * A run number belonging to a step meant something different from the number
 * the user was shown, which is the ambiguity this whole model was changed to
 * remove. Every read now goes through the pipeline run's membership, so nothing
 * consults it any more.
 *
 * Its UNIQUE(submission_job_id, run_number) index was doing real work: it was
 * the backstop against a step quietly executing twice with one of the two
 * becoming invisible — the shape of the worst bug this pipeline has had. So it
 * is replaced rather than dropped, by UNIQUE(pipeline_run_id, job_type), which
 * states the same invariant directly: A STEP EXECUTES AT MOST ONCE IN A RUN, and
 * a second attempt is a new run.
 *
 * ── `submission_jobs.issue_acknowledged_{at,by_user_id}` ────────────────────
 *
 * A decision now lives on the execution it was made about (`step_executions.
 * decision`). It had to be cleared in three places when a step re-ran, because
 * a decision about one run's failure must not carry into the next — and
 * `runAllProcesses`, the one that re-runs everything, did not clear it. A
 * re-executed step now gets a new execution, which was never decided about, so
 * there is no field left to forget. A carried-over step keeps the same
 * execution and therefore the same decision, which is also right: you kept the
 * result, you kept what was decided about it.
 *
 * `run_count` stays. It counts how many times the STEP has executed in the
 * round, which is a different question from which run this is, and one that a
 * carried-over step makes worth asking separately.
 *
 * No backfill. There is no production data, and the standing rule for this
 * project is no backward-compatibility fallbacks.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    // The replacement goes in FIRST, so the invariant is never unguarded — even
    // for the moment between two statements in the same migration.
    await sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "step_executions_run_job_type" '
      + 'ON "step_executions" ("pipeline_run_id", "job_type")'
    );

    const executions = await queryInterface.describeTable('step_executions');
    if (executions.run_number) {
      // Named by Sequelize's own convention when the model created it.
      await sequelize.query('DROP INDEX IF EXISTS "submission_job_runs_job_run"');
      await sequelize.query('DROP INDEX IF EXISTS "step_executions_submission_job_id_run_number"');
      await queryInterface.removeColumn('step_executions', 'run_number');
    }

    const jobs = await queryInterface.describeTable('submission_jobs');
    if (jobs.issue_acknowledged_by_user_id) {
      await queryInterface.removeColumn('submission_jobs', 'issue_acknowledged_by_user_id');
    }
    if (jobs.issue_acknowledged_at) {
      await queryInterface.removeColumn('submission_jobs', 'issue_acknowledged_at');
    }
  },

  async down(queryInterface, Sequelize) {
    const jobs = await queryInterface.describeTable('submission_jobs');
    if (!jobs.issue_acknowledged_at) {
      await queryInterface.addColumn('submission_jobs', 'issue_acknowledged_at', {
        type: Sequelize.DATE, allowNull: true
      });
    }
    if (!jobs.issue_acknowledged_by_user_id) {
      await queryInterface.addColumn('submission_jobs', 'issue_acknowledged_by_user_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      });
    }

    const executions = await queryInterface.describeTable('step_executions');
    if (!executions.run_number) {
      // Restored NOT NULL with a default, because existing rows have no number
      // to restore — the information is gone, and 1 is the only honest answer
      // for a table where a step executes once per run.
      await queryInterface.addColumn('step_executions', 'run_number', {
        type: Sequelize.INTEGER, allowNull: false, defaultValue: 1
      });
    }

    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "step_executions_run_job_type"');
  }
};
