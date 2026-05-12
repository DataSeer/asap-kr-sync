'use strict';

/**
 * Drop known_user_list_entries table.
 *
 * The known-user roster has been removed from the app. Initial role
 * assignment for new Auth0 sign-ins now defaults to 'author' (the User
 * model default); a follow-up will source the role from an Auth0 claim.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS "known_user_list_entries"');
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // Re-create the table at the shape it had after the previous "widen
    // columns" migration so a rollback restores the prior schema. Data is
    // not recoverable — the down path produces an empty table.
    await q(`
      CREATE TABLE IF NOT EXISTS "known_user_list_entries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" VARCHAR(255) NOT NULL UNIQUE,
        "first_name" VARCHAR(255),
        "last_name" VARCHAR(255),
        "orcid" VARCHAR(64),
        "lab" VARCHAR(255),
        "lab_role" VARCHAR(255),
        "asap_role" VARCHAR(255),
        "assigned_role" VARCHAR(20) NOT NULL DEFAULT 'author',
        "team" VARCHAR(64),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "known_user_list_entries_email_lower_idx"
             ON "known_user_list_entries" (LOWER("email"))`);
  }
};
