'use strict';

/**
 * Widen `identifier` and `resource_name` on enrichment_list_entries.
 *
 * Real enrichment data produced by the extractor frequently chains multiple
 * URLs/DOIs into a single `identifier` cell (separated by `;` or `,`), which
 * pushes values well past 500 chars. A few `resource_name` values also exceed
 * 500 chars when the extractor over-captures surrounding text.
 *
 * `identifier` becomes TEXT (URLs/DOIs aren't meaningfully bounded).
 * `resource_name` widens to VARCHAR(1000) — still bounded so runaway extractor
 * output stays visible, just no longer aborts the whole import.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "enrichment_list_entries" ALTER COLUMN "identifier" TYPE TEXT`);
    await q(`ALTER TABLE "enrichment_list_entries" ALTER COLUMN "resource_name" TYPE VARCHAR(1000)`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "enrichment_list_entries" ALTER COLUMN "resource_name" TYPE VARCHAR(500)`);
    await q(`ALTER TABLE "enrichment_list_entries" ALTER COLUMN "identifier" TYPE VARCHAR(500)`);
  }
};
