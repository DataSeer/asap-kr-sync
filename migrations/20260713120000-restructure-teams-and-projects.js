'use strict';

/**
 * Domain-model correction: separate PROJECT from TEAM.
 *
 * Before: a single 2-letter "team" (WH, CS, …) derived from the manuscript ID
 * lived on submissions AND in the teams/user_teams/team_emails tables, and it
 * drove visibility. That 2-letter code is actually the PROJECT (grant), not a
 * team.
 *
 * After:
 *  - `projects`  — the 2-letter grant codes (code, pi_name, title). Reference
 *    data used only to label/validate a submission's project and to power the
 *    dashboard's project filter. Seeded from the ASAP grant list.
 *  - `submissions.team` → `submissions.project` (still the 2-letter code).
 *  - `teams` now holds LAB teams keyed by their leader's name (Alessi, Wood…).
 *    `user_teams` / `team_emails` reference a team by that name. Visibility is
 *    derived from the OWNER's teams (see team.middleware), not the project.
 *
 * The old 2-letter memberships in user_teams / team_emails are meaningless in
 * the new model, so they are cleared; real memberships are (re)loaded from the
 * ASAP roster CSV via scripts/import-user-teams.js.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // 1. projects reference table
    await q(`
      CREATE TABLE IF NOT EXISTS "projects" (
        "code" VARCHAR(10) PRIMARY KEY,
        "pi_name" VARCHAR(255),
        "title" TEXT,
        "active" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "projects_active" ON "projects" ("active")`);

    // Preserve any 2-letter code already in use (from the old teams table) so
    // existing submission.project values keep a matching reference row.
    await q(`
      INSERT INTO "projects" ("code", "title", "active")
      SELECT "code", "name", "active" FROM "teams"
      ON CONFLICT ("code") DO NOTHING
    `);

    // 2. submissions.team -> submissions.project (+ widen, rename index)
    await q(`ALTER TABLE "submissions" RENAME COLUMN "team" TO "project"`);
    await q(`ALTER TABLE "submissions" ALTER COLUMN "project" TYPE VARCHAR(10)`);
    await q(`ALTER INDEX IF EXISTS "submissions_team" RENAME TO "submissions_project"`);

    // 3. Repurpose teams as name-keyed lab teams.
    //    Drop every FK pointing at teams so we can widen the key column.
    await q(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT conname, conrelid::regclass AS tbl
          FROM pg_constraint
          WHERE confrelid = 'teams'::regclass AND contype = 'f'
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        END LOOP;
      END $$;
    `);

    // Old 2-letter memberships are invalid in the new model.
    await q(`DELETE FROM "user_teams"`);
    await q(`DELETE FROM "team_emails"`);
    // Old teams rows are 2-letter codes — now represented in projects.
    await q(`DELETE FROM "teams"`);

    // Widen the key + reference columns to hold team names (e.g. "Reck-Peterson").
    await q(`ALTER TABLE "teams" ALTER COLUMN "code" TYPE VARCHAR(100)`);
    await q(`ALTER TABLE "user_teams" ALTER COLUMN "team" TYPE VARCHAR(100)`);
    await q(`ALTER TABLE "team_emails" ALTER COLUMN "team" TYPE VARCHAR(100)`);

    // Re-add the FKs (name-keyed, cascade on rename/delete).
    await q(`
      ALTER TABLE "user_teams"
      ADD CONSTRAINT "user_teams_team_fkey"
      FOREIGN KEY ("team") REFERENCES "teams" ("code") ON DELETE CASCADE ON UPDATE CASCADE
    `);
    await q(`
      ALTER TABLE "team_emails"
      ADD CONSTRAINT "team_emails_team_fkey"
      FOREIGN KEY ("team") REFERENCES "teams" ("code") ON DELETE CASCADE ON UPDATE CASCADE
    `);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // Best-effort reverse (dev only). Memberships are not restored.
    await q(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT conname, conrelid::regclass AS tbl
          FROM pg_constraint
          WHERE confrelid = 'teams'::regclass AND contype = 'f'
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        END LOOP;
      END $$;
    `);
    await q(`DELETE FROM "user_teams"`);
    await q(`DELETE FROM "team_emails"`);
    await q(`DELETE FROM "teams"`);
    await q(`ALTER TABLE "team_emails" ALTER COLUMN "team" TYPE VARCHAR(10)`);
    await q(`ALTER TABLE "user_teams" ALTER COLUMN "team" TYPE VARCHAR(10)`);
    await q(`ALTER TABLE "teams" ALTER COLUMN "code" TYPE VARCHAR(10)`);
    await q(`
      ALTER TABLE "user_teams"
      ADD CONSTRAINT "user_teams_team_fkey"
      FOREIGN KEY ("team") REFERENCES "teams" ("code") ON DELETE CASCADE
    `);
    await q(`
      ALTER TABLE "team_emails"
      ADD CONSTRAINT "team_emails_team_fkey"
      FOREIGN KEY ("team") REFERENCES "teams" ("code") ON DELETE CASCADE ON UPDATE CASCADE
    `);
    await q(`ALTER INDEX IF EXISTS "submissions_project" RENAME TO "submissions_team"`);
    await q(`ALTER TABLE "submissions" ALTER COLUMN "project" TYPE VARCHAR(2)`);
    await q(`ALTER TABLE "submissions" RENAME COLUMN "project" TO "team"`);
    await q(`DROP TABLE IF EXISTS "projects"`);
  }
};
