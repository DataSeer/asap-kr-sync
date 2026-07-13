'use strict';

/**
 * Backfill user_teams from existing submissions: every submission owner
 * becomes a member of their submissions' teams.
 *
 * This pairs with the visibility change where a teamless submission is
 * visible to PMs who share a team with its owner, and with the create/update
 * flows now auto-assigning uploaders to the resolved team — historical
 * uploaders get the same memberships new uploaders receive automatically.
 *
 * The join on teams.code guards the user_teams.team → teams(code) FK:
 * submissions.team has no FK, so it may hold codes that no longer exist.
 * The id is generated in SQL because databases bootstrapped via model sync
 * have no DB-side default on user_teams.id (the UUIDV4 default is applied
 * by Sequelize in JS on normal inserts).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO "user_teams" ("id", "user_id", "team")
      SELECT gen_random_uuid(), DISTINCT_PAIRS."user_id", DISTINCT_PAIRS."team"
      FROM (
        SELECT DISTINCT s."user_id", s."team"
        FROM "submissions" s
        JOIN "teams" t ON t."code" = s."team"
        WHERE s."team" IS NOT NULL
      ) AS DISTINCT_PAIRS
      ON CONFLICT ("user_id", "team") DO NOTHING
    `);
  },

  async down() {
    // Data backfill only. Memberships may have been legitimately edited by
    // admins since the migration ran, so removing them cannot be done
    // safely — intentional no-op.
  }
};
