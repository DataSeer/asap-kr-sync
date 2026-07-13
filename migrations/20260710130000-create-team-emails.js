'use strict';

/**
 * Admin-managed (team, email) roster used to auto-assign team memberships:
 * whenever a user authenticates or is created, mappings matching their email
 * are applied as user_teams rows (see services/teams/team-email.service.js).
 *
 * FK is ON UPDATE CASCADE so a team-code rename carries the roster along on
 * migration-provisioned databases; the teams controller also rewrites the
 * rows explicitly for databases bootstrapped via model sync (no FK there).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "team_emails" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "team" VARCHAR(10) NOT NULL REFERENCES "teams" ("code") ON DELETE CASCADE ON UPDATE CASCADE,
        "email" VARCHAR(255) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "team_emails_email" ON "team_emails" ("email")`);
    await q(`CREATE INDEX IF NOT EXISTS "team_emails_team" ON "team_emails" ("team")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "team_emails_team_email" ON "team_emails" ("team", "email")`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "team_emails"`);
  }
};
