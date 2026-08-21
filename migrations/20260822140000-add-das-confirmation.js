'use strict';

/**
 * The author confirms the Availability Statement before anything is spent on it.
 *
 * `das_suggestions` is the ONLY module that reads the statement, and the
 * extractor's answer is a proposal — it can find the wrong paragraph, or
 * nothing at all. Running first and asking later spends a model call on text
 * nobody has looked at, and produces advice about the wrong statement.
 *
 * Set when the author confirms, cleared when they edit, so an edited statement
 * is re-confirmed rather than silently re-used. Timestamped rather than a
 * boolean because "when was this agreed" is the question an audit asks, and a
 * boolean cannot answer it.
 *
 * Existing submissions backfill to NULL, which reads as "not yet confirmed" —
 * correct: nobody has been asked.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('submissions');
    if (!table.das_confirmed_at) {
      await queryInterface.addColumn('submissions', 'das_confirmed_at', {
        type: Sequelize.DATE,
        allowNull: true
      });
    }
    if (!table.das_confirmed_by_user_id) {
      await queryInterface.addColumn('submissions', 'das_confirmed_by_user_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('submissions');
    if (table.das_confirmed_by_user_id) await queryInterface.removeColumn('submissions', 'das_confirmed_by_user_id');
    if (table.das_confirmed_at) await queryInterface.removeColumn('submissions', 'das_confirmed_at');
  }
};
