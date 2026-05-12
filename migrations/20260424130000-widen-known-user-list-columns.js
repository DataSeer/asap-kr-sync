'use strict';

/**
 * Widen narrow text columns on known_user_list_entries.
 *
 * Real roster data pushed some lab_role values past 100 chars (one had 115).
 * This migration widens the columns that are realistically free-form to safer
 * sizes. lab_role becomes TEXT (descriptive prose), the rest bump to 255.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "lab_role" TYPE TEXT`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "lab" TYPE VARCHAR(255)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "asap_role" TYPE VARCHAR(255)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "first_name" TYPE VARCHAR(150)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "last_name" TYPE VARCHAR(150)`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "last_name" TYPE VARCHAR(100)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "first_name" TYPE VARCHAR(100)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "asap_role" TYPE VARCHAR(100)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "lab" TYPE VARCHAR(200)`);
    await q(`ALTER TABLE "known_user_list_entries" ALTER COLUMN "lab_role" TYPE VARCHAR(100)`);
  }
};
