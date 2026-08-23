'use strict';

/**
 * What was archived, when, by whom, and where it went.
 *
 * A dashboard that silently loses a submission is alarming; a row saying
 * "archived on 3 March, restorable, checksum abc123" is not. That is the whole
 * job: an archived submission stops being a gap and becomes a fact.
 *
 * ── It outlives the thing it describes ──────────────────────────────────────
 *
 * No foreign key to `submissions` — the row exists precisely because the
 * submission does not. `submission_id` is kept as a plain UUID so a restore can
 * find its tombstone, and so "was this ever here?" is answerable months later.
 *
 * ── Why the checksum ────────────────────────────────────────────────────────
 *
 * The manifest inside the archive proves the archive is internally consistent.
 * This proves the FILE somebody is holding is the one that was made: a
 * tombstone naming an archive nobody can verify is a promise, not a record.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('submission_archives', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      /** Deliberately NOT a foreign key: the submission is gone. */
      submission_id: { type: Sequelize.UUID, allowNull: false },
      manuscript_id: { type: Sequelize.STRING(100), allowNull: true },
      /** Kept so a list of tombstones is readable without opening any of them. */
      title: { type: Sequelize.TEXT, allowNull: true },

      archived_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      archived_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      },

      /** Where the archive was written, as the person who made it saw it. */
      location: { type: Sequelize.TEXT, allowNull: false },
      /** Of the manifest: proves the file in hand is the one that was made. */
      manifest_sha256: { type: Sequelize.STRING(64), allowNull: false },
      /** Per-table row counts and the object count, so a list can say how big. */
      contents: { type: Sequelize.JSONB, allowNull: true },

      /**
       * Set when the submission comes back. The tombstone is NOT deleted:
       * "this was archived in March and restored in May" is a truer record than
       * a row that quietly disappears, and it is the only place that history
       * exists once the archive folder is gone.
       */
      restored_at: { type: Sequelize.DATE, allowNull: true },
      restored_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }
    });

    await queryInterface.addIndex('submission_archives', ['submission_id']);
    await queryInterface.addIndex('submission_archives', ['archived_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('submission_archives');
  }
};
