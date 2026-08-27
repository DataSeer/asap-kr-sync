'use strict';

/**
 * Give users a `deleted` state, so removing an account no longer removes the
 * work attached to it.
 *
 * `DELETE FROM users` cascades: `submissions.user_id` and `change_logs.user_id`
 * are both ON DELETE CASCADE, so deleting a departing colleague destroyed every
 * submission they owned — and, separately, every edit they had ever made to
 * OTHER people's submissions, leaving those with holes in their history and no
 * tombstone. It also stranded the S3 folders and left live queue entries firing
 * against rows that no longer existed.
 *
 * Deletion becomes anonymisation instead: the row survives so the foreign keys
 * still resolve, the identifying fields are replaced, and the credentials are
 * destroyed.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('users');

    if (!table.deleted) {
      await queryInterface.addColumn('users', 'deleted', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      });
    }

    if (!table.deleted_at) {
      await queryInterface.addColumn('users', 'deleted_at', {
        type: Sequelize.DATE,
        allowNull: true
      });
    }

    // Every list and lookup filters on it, so it earns an index.
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "users_deleted" ON "users" ("deleted")'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "users_deleted"');
    const table = await queryInterface.describeTable('users');
    if (table.deleted_at) await queryInterface.removeColumn('users', 'deleted_at');
    if (table.deleted) await queryInterface.removeColumn('users', 'deleted');
  }
};
