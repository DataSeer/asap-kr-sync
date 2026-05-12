'use strict';

/**
 * Create known_user_list_entries table
 *
 * Pre-approved roster of ASAP members used to assign the correct app role on
 * first Auth0 login. Lookup is by lowercased email. If a matching entry exists
 * at first-login, the new user is created with entry.assigned_role instead of
 * the default 'author'. Unknown emails keep the existing 'author' fallback.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      CREATE TABLE IF NOT EXISTS "known_user_list_entries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" VARCHAR(255) NOT NULL UNIQUE,
        "first_name" VARCHAR(100),
        "last_name" VARCHAR(100),
        "orcid" VARCHAR(50),
        "lab" VARCHAR(200),
        "lab_role" VARCHAR(100),
        "asap_role" VARCHAR(100),
        "assigned_role" VARCHAR(20) NOT NULL DEFAULT 'author',
        "team" VARCHAR(100),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await q(`CREATE INDEX IF NOT EXISTS "known_user_list_entries_email_idx" ON "known_user_list_entries" ("email")`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "known_user_list_entries" CASCADE`);
  }
};
