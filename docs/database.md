# Database

The application uses **PostgreSQL** with **Sequelize ORM**. Schema changes are managed through migrations in the `migrations/` directory.

## Configuration

Database configuration is in `src/backend/config/database.js`. It parses the `DATABASE_URL` environment variable and supports per-environment settings:

| Environment | Database | Pool (min/max) | Logging |
|-------------|----------|----------------|---------|
| development | `asap_krsync_dev` | 2 / 10 | Enabled |
| test | `asap_krsync_test` | 1 / 5 | Disabled |
| production | `asap_krsync_prod` | 5 / 20 | Disabled |

SSL can be enabled in production via `DATABASE_SSL`.

## Schema

### Core Tables

#### `users`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `email` | VARCHAR(255) | Unique; lowercased/trimmed via model setter |
| `password_hash` | VARCHAR(255) | bcrypt; nullable (Auth0-only users) |
| `auth0_sub` | VARCHAR(255) | Auth0 subject ID, unique, nullable |
| `name` | VARCHAR(100) | Display name, 2-100 chars |
| `role` | ENUM | `author`, `asap_pm`, `ds_annotator`, `admin` (default `author`) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

Team membership lives in the `user_teams` junction table — there is no per-user `team` column.

**Associations**: has many `UserTeam`, `Submission`, `ChangeLog`, `UserHiddenSubmission`, `RefreshToken`

#### `teams`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER (PK) | Auto-increment |
| `code` | STRING | Unique 2-letter team code |
| `name` | STRING | Team display name |
| `active` | BOOLEAN | Default `true` |

#### `user_teams`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER (PK) | Auto-increment |
| `user_id` | UUID (FK) | References `users.id` |
| `team` | STRING (FK) | References `teams.code` |

#### `submissions`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `user_id` | UUID (FK) | Owner — cascades on delete |
| `team` | VARCHAR(2) | Auto-extracted from `manuscript_id`; not FK-validated |
| `title` | VARCHAR(500) | Required |
| `manuscript_id` | VARCHAR(100) | Optional, validated against the ASAP pattern |
| `data_availability_statement` | TEXT | User-edited DAS |
| `extracted_data_availability_statement` | TEXT | AI-extracted DAS |
| `status` | ENUM | See status values below |
| `notes` | TEXT | Optional notes |
| `current_round` | INTEGER | Default 1; incremented by `POST /:id/new-round` |
| `authors` | JSONB | ORCID extraction results (`{ items, meta }`) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

The current workflow step is derived from `status` (no `current_step` column). Per-detection mentions (software, datasets, materials, protocols) live on `submission_jobs.result.data.items` for the current round — they are **not** denormalized onto the submission row.

**Status values**: `draft`, `step_krt`, `step_pdf`, `step_review`, `step_as`, `step_report`, `completed`

**Status transitions**:
```
draft → step_krt → step_pdf → step_review → step_as → step_report → completed
                                                                         ↓
                  ← (can go back to any previous step) ←←←←←←←←←←←←←←←←←
```

**Associations**: has many `File`, `KRTData`, `ValidationResult`, `ChangeLog`, `Report`, `SubmissionJob`, `UserHiddenSubmission`

#### `files`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | |
| `type` | ENUM | `krt`, `pdf`, `pdf_original`, `supplemental`, `supplemental_pdf`, `report`, `markdown` |
| `file_name` | STRING | Original filename |
| `s3_key` | STRING | S3 object key |
| `s3_url` | STRING | S3 URL |
| `mime_type` | STRING | File MIME type |
| `size` | INTEGER | File size in bytes |
| `version` | INTEGER | Incremented per upload |
| `round` | INTEGER | Submission round |

#### `krt_data`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | |
| `version` | INTEGER | KRT version |
| `resource_type` | STRING | Resource type category |
| `resource_name` | STRING | Resource name |
| `source` | STRING | Source reference |
| `identifier` | STRING | Identifier (RRID, DOI, URL, etc.) |
| `new_reuse` | STRING | "New" or "Reuse" |
| `additional_information` | TEXT | Free text |
| `parsed_identifiers` | JSONB | Structured identifiers extracted from text |
| `is_qc` | BOOLEAN | QC flag (default `false`). Visible/editable only to Administrator and DS Annotator roles. |
| `is_optional` | BOOLEAN | Optional flag (default `false`). Visible/editable only to Administrator and DS Annotator roles. |
| `modified_in_step` | INTEGER | Which step last modified this row |
| `round` | INTEGER | Submission round |
| `origin_row_id` | UUID (FK) | Self-reference for round copies |

#### `validation_results`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | |
| `row_id` | UUID (FK) | References `krt_data.id` |
| `column_name` | STRING | Column with the issue |
| `error_type` | STRING | Validation rule that failed |
| `error_message` | STRING | Human-readable message |
| `severity` | STRING | `error`, `warning`, `info` |
| `suggestion` | STRING | Suggested fix |
| `suggested_value` | VARCHAR | Machine-actionable suggested value (nullable). Lets the editor group resource-type errors into one-click bulk fixes (e.g. "Set 4 → Software/code"). |
| `round` | INTEGER | |

#### `submission_jobs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | Cascades on delete |
| `job_type` | VARCHAR(50) | `das_extraction`, `pdf_analysis`, `markdown_convert`, `software_detection`, `orcid_extraction`, `datasets_detection`, `materials_detection`, `protocols_detection`, `identifier_detection`, `suggestion_generation`, `report_generation`. No DB-level CHECK — values come from the application's `JOB_TYPES` constant. |
| `status` | ENUM | `waiting`, `pending_input`, `queued`, `processing`, `complete`, `failed` (default `queued`) |
| `pg_boss_job_id` | VARCHAR(100) | pg-boss job reference |
| `reference_id` | UUID | Optional link to a related record |
| `result` | JSONB | Job-specific completion data — `{ status, service, counts, timing, data, files }`. Raw API responses are stored on S3 with their keys listed in `result.files`. |
| `error_message` | TEXT | |
| `retry_count` | INTEGER | Default 0 |
| `round` | INTEGER | Default 1 |
| `logs` | JSONB | Structured log entries from job execution (`[]` default) |
| `started_at` / `completed_at` | TIMESTAMPTZ | |

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `change_logs` | Audit trail for all KRT changes (action, source, metadata) |
| `reports` | Generated reports (`type` ENUM `excel`/`pdf`, `file_url`, `metadata` JSONB, `round`) |
| `user_hidden_submissions` | Per-user submission visibility preferences |
| `resource_types` | Configurable resource type catalog (name, description, active, sort_order, `type` ∈ `dataset/software/protocol/lab_material`) |
| `app_config` | Runtime key-value configuration store (JSONB values; e.g. `validation_rules`) |
| `enrichment_list_entries` | Single unified curated reference list for **all four** categories (software, materials, datasets, protocols) — see schema below |
| `refresh_tokens` | Persisted refresh-token rotation chain for the cookie-based session flow (`token_hash`, `expires_at`, `revoked_at`, `revoked_reason`, `replaced_by`, `user_agent`, `ip`) |
| `rejected_resources` | Audit trail of AI suggestions the user rejected. Keyed `(submission_id, round, suggestion_id)`; also indexed by `dedup_key` so future re-runs of the consolidator know which resources were already declined |

### Enrichment List Table

There is **one** `enrichment_list_entries` table backing all four curated lists. The `category` column discriminates between them.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `category` | VARCHAR(20) | `software`, `materials`, `datasets`, or `protocols` (enforced at the model layer via `isIn`) |
| `resource_type` | VARCHAR(100) | KRT resource type (e.g., "Software/code", "Dataset", "Antibody"). Historic "Code/Software" rows from before the 20260522 rename are migrated to "Software/code" by 20260528120000 — the backend also normalises at the emission boundary (`canonicalResourceType`) as a belt-and-braces guard. |
| `resource_name` | VARCHAR(1000) | Resource name (required) — widened from 500 by migration 20260511160000 |
| `source` | TEXT | URL, vendor, repository — widened from VARCHAR(500) by migration 20260512120000 |
| `identifier` | TEXT | RRID, DOI, catalog number, etc. — widened from VARCHAR(500) by migration 20260511160000 |
| `new_reuse` | VARCHAR(10) | "new" or "reuse" |
| `additional_information` | TEXT | Free-text extra info |
| `suggested_entity` | VARCHAR(500) | Canonical name for fuzzy matching |
| `tokens` | JSONB | Keyword array for matching (default `[]`) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

**Indexes**: `category`, `resource_type`, `resource_name`.

## Migrations

All migrations are in `migrations/` and follow the naming pattern `20250101000XXX-description.js`. They use Sequelize's `queryInterface` for schema changes.

Run migrations:
```bash
npm run migrate           # Apply pending migrations
npm run migrate:undo      # Revert the last migration
```

## pg-boss Schema

The pg-boss job queue creates its own tables under the `pgboss` schema (separate from application tables). This is configured automatically on first start.
