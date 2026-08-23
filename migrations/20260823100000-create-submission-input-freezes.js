'use strict';

/**
 * One round, one PDF, one markdown, one KRT.
 *
 * Every step used to resolve its own input independently — nine services
 * running the same `File.findOne({ type }, order: version DESC)`. There was no
 * pipeline-level notion of "the inputs this round is being processed from", so
 * a file replaced mid-run split the round in two: some steps had read the old
 * version, some the new, and nothing recorded that it had happened.
 *
 * The KRT was worse, because nothing restarts when it changes. The detectors
 * are seeded from `krt_data` when each one runs, and PDF Analysis reads
 * `krt_data` again when it consolidates. An author editing their table between
 * those two — which the workflow actively invites, the editor being one click
 * away — got an analysis whose detections were seeded from one table and whose
 * consolidation reconciled against another. Silently.
 *
 * A row here is created by the FIRST step in a round that reads an input, and
 * every later reader in that round is handed the same thing. The freeze levels
 * fall out of the dependency graph rather than being configured: the PDF is
 * frozen by Markdown Convert at the start of the round, and the KRT by the
 * first detector — which is gated on `krt_curated`, i.e. after the author has
 * validated it.
 *
 * Files are stored by REFERENCE (`file_id` + the version and key as they were),
 * because a File row is immutable once written. The KRT has no immutable
 * version to point at — `krt_data` rows ARE the live editing surface — so its
 * `payload` holds the rows themselves. That is the only copy in this table, and
 * it is small: 89 rows on an average KRT, 335 on the largest seen.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('submission_input_freezes', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true
        },
        submission_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'submissions', key: 'id' },
          onDelete: 'CASCADE'
        },
        round: { type: Sequelize.INTEGER, allowNull: false },
        // 'pdf' | 'markdown' | 'krt'. Deliberately not an enum: adding an input
        // kind should not need a migration that rewrites a type.
        input_kind: { type: Sequelize.STRING(32), allowNull: false },

        // File inputs — by reference.
        file_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'files', key: 'id' },
          onDelete: 'SET NULL'
        },
        // Copied rather than joined: the answer to "what did this run read"
        // must survive the file row being removed, and a NULLed file_id would
        // otherwise erase it.
        file_version: { type: Sequelize.INTEGER, allowNull: true },
        s3_key: { type: Sequelize.TEXT, allowNull: true },
        sha256: { type: Sequelize.STRING(64), allowNull: true },
        bytes: { type: Sequelize.INTEGER, allowNull: true },

        // Row inputs — by value, because there is nothing to point at.
        payload: { type: Sequelize.JSONB, allowNull: true },
        row_count: { type: Sequelize.INTEGER, allowNull: true },

        // Who read it first. Not for display so much as for the re-freeze rule:
        // an input is only re-frozen when every step that reads it is re-run.
        frozen_by_job_type: { type: Sequelize.STRING(64), allowNull: true },
        frozen_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction: t });

      // The whole point: one freeze per input per round. Two detectors starting
      // in the same millisecond both find no freeze and both try to create one;
      // this is what makes the loser's insert a no-op instead of a second,
      // different answer to "which PDF is this round reading".
      await queryInterface.addConstraint('submission_input_freezes', {
        fields: ['submission_id', 'round', 'input_kind'],
        type: 'unique',
        name: 'submission_input_freezes_unique_per_round',
        transaction: t
      });

      await queryInterface.addIndex('submission_input_freezes', ['submission_id', 'round'], {
        name: 'submission_input_freezes_submission_round',
        transaction: t
      });

      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('submission_input_freezes');
  }
};
