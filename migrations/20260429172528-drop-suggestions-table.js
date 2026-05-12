'use strict';

/**
 * Drop the legacy `suggestions` table.
 *
 * Suggestions are now derived live as the diff between the Generated KRT
 * (output of pdf_analysis) and krt_data. User decisions:
 *   - Approval: applied to krt_data + audit-logged in change_log
 *               (with source='ai_suggestion').
 *   - Rejection: persisted in rejected_resources (round-scoped, dedup-keyed).
 *
 * No data migration needed — every suggestion that mattered was either
 * already approved (applied to krt_data) or already rejected. New rejections
 * land in the new table going forward.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable('suggestions');
  },

  async down(queryInterface, Sequelize) {
    // Restore the original schema. This is the shape that was created by
    // the older migration and used in production. Bringing it back means we
    // have an empty `suggestions` table again — historical content cannot be
    // recovered.
    await queryInterface.createTable('suggestions', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      submission_job_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'submission_jobs', key: 'id' },
        onDelete: 'CASCADE'
      },
      submission_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'submissions', key: 'id' },
        onDelete: 'CASCADE'
      },
      round: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      source: { type: Sequelize.STRING(50), allowNull: false },
      type: { type: Sequelize.STRING(50), allowNull: false },
      action: { type: Sequelize.STRING(50), allowNull: false },
      status: { type: Sequelize.STRING(50), allowNull: false, defaultValue: 'pending' },
      title: Sequelize.TEXT,
      description: Sequelize.TEXT,
      detail: Sequelize.TEXT,
      confidence: Sequelize.FLOAT,
      exists_in_krt: Sequelize.STRING(50),
      matched_krt_row_id: Sequelize.UUID,
      data: Sequelize.JSONB,
      reason: Sequelize.TEXT,
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('suggestions', ['submission_id', 'round']);
    await queryInterface.addIndex('suggestions', ['submission_job_id']);
  }
};
