'use strict';

/**
 * `run_count` counts executions from zero.
 *
 * It used to be SET to the step's own run number, so a default of 1 meant "the
 * first run" and was right. It is INCREMENTED now — the step no longer has a
 * number of its own — and the same default made a step that had executed once
 * report two. The report's "Runs" column said 2 for every step of a pipeline
 * that had run exactly once, which is how this was found.
 *
 * Backfilled from the executions themselves rather than reset to zero: the
 * answer is knowable, and a column that says "unknown" where it could say "1"
 * is worse than one that is simply corrected.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('submission_jobs', 'run_count', {
      type: Sequelize.INTEGER, allowNull: false, defaultValue: 0
    });

    await queryInterface.sequelize.query(`
      UPDATE "submission_jobs" j
      SET run_count = (
        SELECT count(*) FROM "step_executions" e WHERE e.submission_job_id = j.id
      )
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('submission_jobs', 'run_count', {
      type: Sequelize.INTEGER, allowNull: false, defaultValue: 1
    });
  }
};
