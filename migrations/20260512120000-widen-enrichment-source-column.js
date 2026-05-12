'use strict';

/**
 * Widen `source` on enrichment_list_entries from VARCHAR(500) to TEXT.
 *
 * Curated materials data aggregates supplier aliases into a single `source`
 * cell (e.g. "Jackson Laboratory; The Jackson Laboratory; (Jackson Labs); Jax;
 * ..."), pushing some rows past 500 chars. Same rationale as the earlier
 * `identifier` widening — these are concatenated lists, not bounded names.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "enrichment_list_entries" ALTER COLUMN "source" TYPE TEXT`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "enrichment_list_entries" ALTER COLUMN "source" TYPE VARCHAR(500)`);
  }
};
