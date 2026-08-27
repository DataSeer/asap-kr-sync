'use strict';

/**
 * Two index names left behind by the table rename.
 *
 * `submission_job_runs` became `step_executions`, and Postgres renames neither
 * the indexes nor the constraints that a table was created with. Purely
 * cosmetic — nothing reads an index by name — but a primary key called
 * `submission_job_runs_pkey` on a table called `step_executions` is the kind of
 * thing that costs somebody an afternoon, in the same way the enum type would
 * have if it had not been renamed with the table.
 *
 * `IF EXISTS` throughout so a database built fresh from the migrations — where
 * these were created under their new names — is left alone.
 */

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.query(
      'ALTER INDEX IF EXISTS "submission_job_runs_pkey" RENAME TO "step_executions_pkey"'
    );
    await sequelize.query(
      'ALTER INDEX IF EXISTS "submission_job_runs_triggered_by" '
      + 'RENAME TO "step_executions_triggered_by"'
    );
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.query(
      'ALTER INDEX IF EXISTS "step_executions_pkey" RENAME TO "submission_job_runs_pkey"'
    );
    await sequelize.query(
      'ALTER INDEX IF EXISTS "step_executions_triggered_by" '
      + 'RENAME TO "submission_job_runs_triggered_by"'
    );
  }
};
