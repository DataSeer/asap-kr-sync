'use strict';

/**
 * A failure pauses what comes after it, until somebody decides.
 *
 * `failed` used to count as terminal alongside `complete`, so a step that failed
 * released its dependents and they ran anyway. The consolidator would build a
 * Generated KRT from four detectors instead of five and say nothing about the
 * fifth — a quietly thinner answer, which is the shape of mistake this whole
 * branch has been removing.
 *
 * Now the dependents hold at `waiting`, and the person looking at it chooses:
 *
 *   - **Retry** the failed step — the usual answer when an external service was
 *     down and has come back;
 *   - **Continue** without it, which is what these columns record.
 *
 * Recorded rather than inferred, with who and when, because "this report was
 * built without software detection, and a person chose that" is exactly the
 * question the run history exists to answer. A boolean could not answer it, and
 * an absent row could not be told apart from a step nobody has looked at yet.
 *
 * Cleared when the step is retried or restarted: the acknowledgement is about
 * one failure, not about the step.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('submission_jobs');

    if (!table.failure_acknowledged_at) {
      await queryInterface.addColumn('submission_jobs', 'failure_acknowledged_at', {
        type: Sequelize.DATE,
        allowNull: true
      });
    }
    if (!table.failure_acknowledged_by_user_id) {
      await queryInterface.addColumn('submission_jobs', 'failure_acknowledged_by_user_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('submission_jobs');
    if (table.failure_acknowledged_by_user_id) {
      await queryInterface.removeColumn('submission_jobs', 'failure_acknowledged_by_user_id');
    }
    if (table.failure_acknowledged_at) {
      await queryInterface.removeColumn('submission_jobs', 'failure_acknowledged_at');
    }
  }
};
