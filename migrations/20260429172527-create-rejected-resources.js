'use strict';

/**
 * Create the rejected_resources table — the persistent state that backs the
 * "user said no to this suggestion" half of the diff-based suggestions
 * pipeline. Approvals don't need a row here (they apply to krt_data and are
 * audit-logged in change_log via source='ai_suggestion').
 *
 * Keys:
 *   - dedup_key is the stable resource fingerprint computed by
 *     identifier-normalize.service. Survives PDF Analysis re-runs.
 *   - suggestion_id is the synthetic UI id ("add:<key>" or "edit:<key>:<col>").
 *
 * The unique (submission_id, round, suggestion_id) prevents double-rejection
 * within a round.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('rejected_resources', {
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
      round: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      suggestion_id: { type: Sequelize.TEXT, allowNull: false },
      dedup_key:     { type: Sequelize.TEXT, allowNull: false },

      // Audit snapshot of what was rejected (immutable; survives Generated-KRT
      // changes so the user's history view is self-contained).
      resource_type:   { type: Sequelize.TEXT, allowNull: true },
      resource_name:   { type: Sequelize.TEXT, allowNull: true },
      identifier:      { type: Sequelize.TEXT, allowNull: true },
      new_reuse:       { type: Sequelize.TEXT, allowNull: true },
      proposed_value:  { type: Sequelize.TEXT, allowNull: true },
      column_name:     { type: Sequelize.TEXT, allowNull: true },

      reason:       { type: Sequelize.TEXT, allowNull: true },
      rejected_at:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      rejected_by:  { type: Sequelize.UUID, allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });

    await queryInterface.addIndex('rejected_resources', ['submission_id', 'round'], {
      name: 'rejected_resources_submission_round_idx'
    });
    await queryInterface.addIndex('rejected_resources', ['submission_id', 'round', 'suggestion_id'], {
      name: 'rejected_resources_unique_per_round',
      unique: true
    });
    await queryInterface.addIndex('rejected_resources', ['submission_id', 'round', 'dedup_key'], {
      name: 'rejected_resources_dedup_lookup_idx'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('rejected_resources');
  }
};
