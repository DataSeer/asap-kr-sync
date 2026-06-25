'use strict';

/**
 * Add `is_qc` and `is_optional` flags to krt_data (request G1).
 *
 * These mark a KRT row as a QC dataset and/or as optional (e.g. Sanger
 * sequencing often noted as optional). They are only shown/edited by
 * Administrator and DS Annotator roles; regular ASAP users never see them.
 * Both default to false so existing rows are unaffected.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      ALTER TABLE "krt_data"
      ADD COLUMN IF NOT EXISTS "is_qc" BOOLEAN NOT NULL DEFAULT false
    `);
    await q(`
      ALTER TABLE "krt_data"
      ADD COLUMN IF NOT EXISTS "is_optional" BOOLEAN NOT NULL DEFAULT false
    `);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "krt_data" DROP COLUMN IF EXISTS "is_qc"`);
    await q(`ALTER TABLE "krt_data" DROP COLUMN IF EXISTS "is_optional"`);
  }
};
