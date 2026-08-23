'use strict';

/**
 * Promoting a pipeline result into the submission becomes a recorded act.
 *
 * Today three steps write submission state directly: DAS extraction sets
 * `data_availability_statement`, ORCID extraction sets `authors`, and applying a
 * suggestion edits `krt_data`. Each write is invisible afterwards — nothing says
 * which run produced the value, or that a value was promoted at all.
 *
 * Two consequences, and the second is the reason this is early in the order:
 *
 *   1. **A run is not a snapshot.** Open run 1 and you read run 2's statement,
 *      because there is only one field and the newest run owns it.
 *   2. **A run cannot be re-executed without side effects**, which is what makes
 *      replay and evaluation impossible.
 *
 * The rule that fixes both: a step writes only to its own execution, and
 * promoting that output is a SEPARATE, attributed act. This migration is what
 * lets the act be recorded, on the table that already answers who/what/when.
 *
 * ── Three changes ───────────────────────────────────────────────────────────
 *
 * `step_execution_id` — the provenance. One row then answers "this statement
 * came from run 2's extraction, accepted by Nicolas at 14:02". SET NULL rather
 * than CASCADE: retention may eventually prune an execution's payload, and
 * losing the record that the value was applied at all would be far worse than
 * losing the pointer to where it came from.
 *
 * `user_id` becomes nullable — the system is an actor. An automatic apply is
 * the same row with nobody behind it, and the alternative is to invent a user
 * or to skip the log, which is how these writes became invisible in the first
 * place. Every existing row has a user, so nothing is loosened retroactively.
 *
 * `apply` and `pipeline` join the action and source enums. `edit` would have
 * done, and would have buried these among the hand-typed changes they are meant
 * to be distinguishable from: "the extractor filled this in" and "a person
 * typed this" are the two facts the Availability step exists to tell apart.
 *
 * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, which is why
 * this migration deliberately does not open one.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('change_logs');

    if (!table.step_execution_id) {
      await queryInterface.addColumn('change_logs', 'step_execution_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'step_executions', key: 'id' },
        onDelete: 'SET NULL'
      });
      await queryInterface.addIndex('change_logs', ['step_execution_id']);
    }

    // Raw SQL, not changeColumn. Given `references`, Sequelize's changeColumn
    // emits the ADD FOREIGN KEY and silently omits the DROP NOT NULL — so the
    // migration reported success and the column stayed NOT NULL, which would
    // have surfaced later as every automatic apply failing to record. It also
    // adds a duplicate constraint each time it runs.
    await queryInterface.sequelize.query(
      'ALTER TABLE "change_logs" ALTER COLUMN "user_id" DROP NOT NULL'
    );

    // IF NOT EXISTS so a re-run is a no-op: an enum value cannot be dropped, so
    // `down` leaves both in place and `up` must tolerate finding them.
    await queryInterface.sequelize.query(
      'ALTER TYPE "enum_change_logs_action" ADD VALUE IF NOT EXISTS \'apply\''
    );
    await queryInterface.sequelize.query(
      'ALTER TYPE "enum_change_logs_source" ADD VALUE IF NOT EXISTS \'pipeline\''
    );
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('change_logs');

    if (table.step_execution_id) {
      await queryInterface.removeColumn('change_logs', 'step_execution_id');
    }

    // Only safe while no automatic apply has been recorded — those rows have no
    // user, and NOT NULL would refuse them.
    const [[{ orphans }]] = await queryInterface.sequelize.query(
      'SELECT count(*)::int AS orphans FROM change_logs WHERE user_id IS NULL'
    );
    if (!orphans) {
      await queryInterface.sequelize.query(
        'ALTER TABLE "change_logs" ALTER COLUMN "user_id" SET NOT NULL'
      );
    }

    // The enum values stay. Postgres cannot drop one, and rebuilding both types
    // to remove a label would risk far more than it removes.
  }
};
