'use strict';

/**
 * Initial Schema Migration (v1)
 *
 * Creates all tables for the KRT Assist application.
 * Fully idempotent — uses IF NOT EXISTS throughout for safe re-runs.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // ---- CLEAN SLATE: drop stale tables from failed previous migrations ----
    // (preserves users, user_teams, teams which use IF NOT EXISTS below)
    await q(`DROP TABLE IF EXISTS "suggestions" CASCADE`);
    await q(`DROP TABLE IF EXISTS "enrichment_list_entries" CASCADE`);
    await q(`DROP TABLE IF EXISTS "submission_jobs" CASCADE`);
    await q(`DROP TABLE IF EXISTS "app_config" CASCADE`);
    await q(`DROP TABLE IF EXISTS "resource_types" CASCADE`);
    await q(`DROP TABLE IF EXISTS "user_hidden_submissions" CASCADE`);
    await q(`DROP TABLE IF EXISTS "reports" CASCADE`);
    await q(`DROP TABLE IF EXISTS "change_logs" CASCADE`);
    await q(`DROP TABLE IF EXISTS "validation_results" CASCADE`);
    await q(`DROP TABLE IF EXISTS "krt_data" CASCADE`);
    await q(`DROP TABLE IF EXISTS "files" CASCADE`);
    await q(`DROP TABLE IF EXISTS "submissions" CASCADE`);
    // Also drop legacy tables that no longer exist in schema
    await q(`DROP TABLE IF EXISTS "lm_analyses" CASCADE`);
    await q(`DROP TABLE IF EXISTS "software_list_entries" CASCADE`);
    await q(`DROP TABLE IF EXISTS "materials_list_entries" CASCADE`);
    await q(`DROP TABLE IF EXISTS "datasets_list_entries" CASCADE`);
    await q(`DROP TABLE IF EXISTS "protocols_list_entries" CASCADE`);

    // Drop stale ENUM types (tables that used them are already dropped above)
    // Then recreate with correct values. Users table ENUM is handled separately.
    await q(`DROP TYPE IF EXISTS "public"."enum_submissions_status" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_files_type" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_validation_results_severity" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_change_logs_action" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_change_logs_source" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_reports_type" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_submission_jobs_status" CASCADE`);
    await q(`DROP TYPE IF EXISTS "public"."enum_lm_analyses_status" CASCADE`);

    // Helper: create ENUM type (drop first ensures fresh values)
    const createEnum = (name, values) => q(`
      CREATE TYPE "public"."${name}" AS ENUM (${values.map(v => `'${v}'`).join(', ')})
    `);

    // ---- ENUM TYPES ----
    // enum_users_role: preserved (users table not dropped), use IF NOT EXISTS
    await q(`
      DO $$ BEGIN
        CREATE TYPE "public"."enum_users_role" AS ENUM ('author', 'asap_pm', 'ds_annotator', 'admin');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await createEnum('enum_submissions_status', ['draft', 'step_krt', 'step_pdf', 'step_review', 'step_as', 'step_report', 'completed']);
    await createEnum('enum_files_type', ['krt', 'pdf', 'pdf_original', 'supplemental', 'supplemental_pdf', 'report', 'markdown']);
    await createEnum('enum_validation_results_severity', ['error', 'warning', 'info']);
    await createEnum('enum_change_logs_action', ['upload', 'edit', 'add_row', 'delete_row', 'approve_change', 'reject_change', 'import_findings', 'new_round']);
    await createEnum('enum_change_logs_source', ['manual', 'ai_suggestion', 'krt_validation']);
    await createEnum('enum_reports_type', ['excel', 'pdf']);
    await createEnum('enum_submission_jobs_status', ['waiting', 'pending_input', 'queued', 'processing', 'complete', 'failed']);

    // ---- 1. USERS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" VARCHAR(255) NOT NULL UNIQUE,
        "password_hash" VARCHAR(255),
        "auth0_sub" VARCHAR(255) UNIQUE,
        "name" VARCHAR(100) NOT NULL,
        "role" "public"."enum_users_role" NOT NULL DEFAULT 'author',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "users_email" ON "users" ("email")`);
    await q(`CREATE INDEX IF NOT EXISTS "users_role" ON "users" ("role")`);

    // ---- 2. TEAMS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "teams" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" VARCHAR(10) NOT NULL UNIQUE,
        "name" VARCHAR(100),
        "active" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "teams_code" ON "teams" ("code")`);
    await q(`CREATE INDEX IF NOT EXISTS "teams_active" ON "teams" ("active")`);

    // ---- 3. USER_TEAMS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "user_teams" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "team" VARCHAR(10) NOT NULL REFERENCES "teams" ("code") ON DELETE CASCADE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "user_teams_user_id" ON "user_teams" ("user_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "user_teams_team" ON "user_teams" ("team")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "user_teams_user_id_team" ON "user_teams" ("user_id", "team")`);

    // ---- 4. SUBMISSIONS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "submissions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "team" VARCHAR(2),
        "title" VARCHAR(500) NOT NULL,
        "manuscript_id" VARCHAR(100),
        "data_availability_statement" TEXT,
        "extracted_data_availability_statement" TEXT,
        "status" "public"."enum_submissions_status" NOT NULL DEFAULT 'draft',
        "notes" TEXT,
        "current_round" INTEGER NOT NULL DEFAULT 1,
        "authors" JSONB,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "submissions_user_id" ON "submissions" ("user_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "submissions_team" ON "submissions" ("team")`);
    await q(`CREATE INDEX IF NOT EXISTS "submissions_status" ON "submissions" ("status")`);
    await q(`CREATE INDEX IF NOT EXISTS "submissions_manuscript_id" ON "submissions" ("manuscript_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "submissions_created_at" ON "submissions" ("created_at")`);

    // ---- 5. FILES ----
    await q(`
      CREATE TABLE IF NOT EXISTS "files" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "type" "public"."enum_files_type" NOT NULL,
        "file_name" VARCHAR(255) NOT NULL,
        "s3_key" VARCHAR(500) NOT NULL,
        "mime_type" VARCHAR(100),
        "size" INTEGER,
        "version" INTEGER NOT NULL DEFAULT 1,
        "round" INTEGER NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "files_submission_id" ON "files" ("submission_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "files_submission_id_type" ON "files" ("submission_id", "type")`);
    await q(`CREATE INDEX IF NOT EXISTS "files_submission_id_type_version" ON "files" ("submission_id", "type", "version")`);

    // ---- 6. KRT_DATA ----
    await q(`
      CREATE TABLE IF NOT EXISTS "krt_data" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "resource_type" VARCHAR(100),
        "resource_name" VARCHAR(500),
        "source" VARCHAR(500),
        "identifier" VARCHAR(500),
        "new_reuse" VARCHAR(10),
        "additional_information" TEXT,
        "parsed_identifiers" JSONB DEFAULT '{}',
        "round" INTEGER NOT NULL DEFAULT 1,
        "origin_row_id" UUID REFERENCES "krt_data" ("id") ON DELETE SET NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "krt_data_submission_id" ON "krt_data" ("submission_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "krt_data_submission_id_round" ON "krt_data" ("submission_id", "round")`);

    // ---- 7. VALIDATION_RESULTS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "validation_results" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "row_id" UUID NOT NULL REFERENCES "krt_data" ("id") ON DELETE CASCADE,
        "column_name" VARCHAR(50) NOT NULL,
        "error_type" VARCHAR(50) NOT NULL,
        "error_message" VARCHAR(500) NOT NULL,
        "severity" "public"."enum_validation_results_severity" NOT NULL DEFAULT 'error',
        "suggestion" VARCHAR(500),
        "round" INTEGER NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "validation_results_submission_id" ON "validation_results" ("submission_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "validation_results_submission_id_row_id" ON "validation_results" ("submission_id", "row_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "validation_results_submission_id_severity" ON "validation_results" ("submission_id", "severity")`);

    // ---- 8. CHANGE_LOGS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "change_logs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "user_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "action" "public"."enum_change_logs_action" NOT NULL,
        "source" "public"."enum_change_logs_source",
        "step" INTEGER,
        "row_id" UUID REFERENCES "krt_data" ("id") ON DELETE SET NULL,
        "column_name" VARCHAR(50),
        "old_value" TEXT,
        "new_value" TEXT,
        "description" TEXT,
        "metadata" JSONB DEFAULT '{}',
        "round" INTEGER NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "change_logs_submission_id" ON "change_logs" ("submission_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "change_logs_user_id" ON "change_logs" ("user_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "change_logs_submission_id_action" ON "change_logs" ("submission_id", "action")`);
    await q(`CREATE INDEX IF NOT EXISTS "change_logs_created_at" ON "change_logs" ("created_at")`);
    await q(`CREATE INDEX IF NOT EXISTS "change_logs_source" ON "change_logs" ("source")`);
    await q(`CREATE INDEX IF NOT EXISTS "change_logs_row_id" ON "change_logs" ("row_id")`);

    // ---- 9. REPORTS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "reports" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "type" "public"."enum_reports_type" NOT NULL,
        "file_url" VARCHAR(1000),
        "metadata" JSONB DEFAULT '{}',
        "round" INTEGER NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "reports_submission_id" ON "reports" ("submission_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "reports_submission_id_type" ON "reports" ("submission_id", "type")`);

    // ---- 10. USER_HIDDEN_SUBMISSIONS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "user_hidden_submissions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "user_hidden_submissions_user_id" ON "user_hidden_submissions" ("user_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "user_hidden_submissions_submission_id" ON "user_hidden_submissions" ("submission_id")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "user_hidden_submissions_user_id_submission_id" ON "user_hidden_submissions" ("user_id", "submission_id")`);

    // ---- 11. RESOURCE_TYPES ----
    await q(`
      CREATE TABLE IF NOT EXISTS "resource_types" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" VARCHAR(100) NOT NULL UNIQUE,
        "description" TEXT,
        "active" BOOLEAN NOT NULL DEFAULT true,
        "type" VARCHAR(20) NOT NULL DEFAULT 'lab_material',
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "resource_types_name" ON "resource_types" ("name")`);
    await q(`CREATE INDEX IF NOT EXISTS "resource_types_active" ON "resource_types" ("active")`);
    await q(`CREATE INDEX IF NOT EXISTS "resource_types_sort_order" ON "resource_types" ("sort_order")`);

    // ---- 12. APP_CONFIG ----
    await q(`
      CREATE TABLE IF NOT EXISTS "app_config" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" VARCHAR(100) NOT NULL UNIQUE,
        "value" JSONB NOT NULL,
        "description" TEXT,
        "category" VARCHAR(50) NOT NULL DEFAULT 'general',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "app_config_key" ON "app_config" ("key")`);
    await q(`CREATE INDEX IF NOT EXISTS "app_config_category" ON "app_config" ("category")`);

    // ---- 13. SUBMISSION_JOBS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "submission_jobs" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "job_type" VARCHAR(50) NOT NULL,
        "status" "public"."enum_submission_jobs_status" NOT NULL DEFAULT 'queued',
        "pg_boss_job_id" VARCHAR(100),
        "reference_id" UUID,
        "result" JSONB,
        "error_message" TEXT,
        "retry_count" INTEGER NOT NULL DEFAULT 0,
        "round" INTEGER NOT NULL DEFAULT 1,
        "logs" JSONB DEFAULT '[]',
        "started_at" TIMESTAMPTZ,
        "completed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "submission_jobs_submission_id_round" ON "submission_jobs" ("submission_id", "round")`);
    await q(`CREATE INDEX IF NOT EXISTS "submission_jobs_submission_id_job_type_round" ON "submission_jobs" ("submission_id", "job_type", "round")`);

    // ---- 14. ENRICHMENT_LIST_ENTRIES ----
    await q(`
      CREATE TABLE IF NOT EXISTS "enrichment_list_entries" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "category" VARCHAR(20) NOT NULL,
        "resource_type" VARCHAR(100) NOT NULL,
        "resource_name" VARCHAR(500) NOT NULL,
        "source" VARCHAR(500),
        "identifier" VARCHAR(500),
        "new_reuse" VARCHAR(10),
        "additional_information" TEXT,
        "suggested_entity" VARCHAR(500),
        "tokens" JSONB DEFAULT '[]',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "enrichment_list_entries_category" ON "enrichment_list_entries" ("category")`);
    await q(`CREATE INDEX IF NOT EXISTS "enrichment_list_entries_resource_type" ON "enrichment_list_entries" ("resource_type")`);
    await q(`CREATE INDEX IF NOT EXISTS "enrichment_list_entries_resource_name" ON "enrichment_list_entries" ("resource_name")`);

    // ---- 15. SUGGESTIONS ----
    await q(`
      CREATE TABLE IF NOT EXISTS "suggestions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "submission_job_id" UUID NOT NULL REFERENCES "submission_jobs" ("id") ON DELETE CASCADE,
        "submission_id" UUID NOT NULL REFERENCES "submissions" ("id") ON DELETE CASCADE,
        "round" INTEGER NOT NULL DEFAULT 1,
        "source" VARCHAR(50) NOT NULL,
        "type" VARCHAR(20) NOT NULL,
        "action" VARCHAR(20) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
        "title" VARCHAR(500),
        "description" TEXT,
        "detail" TEXT,
        "confidence" FLOAT,
        "exists_in_krt" VARCHAR(10),
        "matched_krt_row_id" UUID REFERENCES "krt_data" ("id") ON DELETE SET NULL,
        "data" JSONB NOT NULL,
        "rejection_reason" TEXT,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS "suggestions_submission_id_round" ON "suggestions" ("submission_id", "round")`);
    await q(`CREATE INDEX IF NOT EXISTS "suggestions_submission_job_id" ON "suggestions" ("submission_job_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "suggestions_submission_id_status" ON "suggestions" ("submission_id", "status")`);
    await q(`CREATE INDEX IF NOT EXISTS "suggestions_submission_id_source_round" ON "suggestions" ("submission_id", "source", "round")`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // Drop tables in reverse dependency order
    await q(`DROP TABLE IF EXISTS "suggestions" CASCADE`);
    await q(`DROP TABLE IF EXISTS "enrichment_list_entries" CASCADE`);
    await q(`DROP TABLE IF EXISTS "submission_jobs" CASCADE`);
    await q(`DROP TABLE IF EXISTS "app_config" CASCADE`);
    await q(`DROP TABLE IF EXISTS "resource_types" CASCADE`);
    await q(`DROP TABLE IF EXISTS "user_hidden_submissions" CASCADE`);
    await q(`DROP TABLE IF EXISTS "reports" CASCADE`);
    await q(`DROP TABLE IF EXISTS "change_logs" CASCADE`);
    await q(`DROP TABLE IF EXISTS "validation_results" CASCADE`);
    await q(`DROP TABLE IF EXISTS "krt_data" CASCADE`);
    await q(`DROP TABLE IF EXISTS "files" CASCADE`);
    await q(`DROP TABLE IF EXISTS "submissions" CASCADE`);
    await q(`DROP TABLE IF EXISTS "user_teams" CASCADE`);
    await q(`DROP TABLE IF EXISTS "teams" CASCADE`);
    await q(`DROP TABLE IF EXISTS "users" CASCADE`);

    // Drop ENUM types
    await q(`DROP TYPE IF EXISTS "public"."enum_submission_jobs_status"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_reports_type"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_change_logs_source"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_change_logs_action"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_validation_results_severity"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_files_type"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_submissions_status"`);
    await q(`DROP TYPE IF EXISTS "public"."enum_users_role"`);
  }
};
