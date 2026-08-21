'use strict';

/**
 * Record who asked for each step to run.
 *
 * `userId` was already threaded from every controller, through each service's
 * `queue*` function, into the orchestrator and on to `buildJobData` — and then
 * dropped: eleven of the twelve steps never put it in their payload, the
 * twelfth (`pdf_analysis`) put it there and never read it, and no column ever
 * held it. Plumbing that looked deliberate and carried nothing, so an advance
 * that omitted it looked like a bug rather than the norm.
 *
 * This is the column it was always heading for. Named `triggered_by_user_id`
 * rather than `user_id` because the submission already has an owner and these
 * are different people: a curator re-running one detector on an author's
 * manuscript is the trigger, not the owner.
 *
 * NULL is meaningful — the row predates this column, or no user was involved.
 *
 * ON DELETE SET NULL: accounts are anonymised rather than removed (see
 * 20260820130000), so this should never fire; if a row is ever hard-deleted,
 * losing the attribution is better than blocking the delete.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('submission_jobs');

    if (!table.triggered_by_user_id) {
      await queryInterface.addColumn('submission_jobs', 'triggered_by_user_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      });
    }

    // "What has this person been running?" is the question the column exists
    // for, and it is the one that would otherwise scan the table.
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "submission_jobs_triggered_by_user_id" '
      + 'ON "submission_jobs" ("triggered_by_user_id")'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'DROP INDEX IF EXISTS "submission_jobs_triggered_by_user_id"'
    );
    const table = await queryInterface.describeTable('submission_jobs');
    if (table.triggered_by_user_id) {
      await queryInterface.removeColumn('submission_jobs', 'triggered_by_user_id');
    }
  }
};
