'use strict';

/**
 * Add `suggested_value` to validation_results (request E).
 *
 * Carries the machine-actionable canonical value for a fixable validation
 * error (e.g. an invalid "Code" RESOURCE TYPE → "Software/code"), so the
 * frontend can offer a one-click fix and group equal targets into a single
 * bulk action. Nullable: most errors have no concrete target.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "validation_results"
      ADD COLUMN IF NOT EXISTS "suggested_value" VARCHAR(200)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "validation_results" DROP COLUMN IF EXISTS "suggested_value"`
    );
  }
};
