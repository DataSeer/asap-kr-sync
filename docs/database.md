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
| `email` | STRING | Unique |
| `password_hash` | STRING | bcrypt, nullable (Auth0 users) |
| `auth0_sub` | STRING | Auth0 subject ID, nullable |
| `name` | STRING | Display name |
| `role` | ENUM | `author`, `asap_pm`, `ds_annotator`, `admin` |
| `team` | STRING(2) | Legacy team field |
| `created_at` / `updated_at` | TIMESTAMP | Auto-managed |

**Associations**: has many `UserTeam`, `Submission`, `ChangeLog`, `UserHiddenSubmission`

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
| `user_id` | UUID (FK) | Owner |
| `team` | STRING(2) | Auto-extracted from manuscript ID |
| `title` | STRING(500) | Required |
| `manuscript_id` | STRING(100) | Optional |
| `data_availability_statement` | TEXT | User-edited DAS |
| `extracted_data_availability_statement` | TEXT | AI-extracted DAS |
| `status` | ENUM | See status values below |
| `current_step` | INTEGER | 1–5, auto-computed from status |
| `notes` | TEXT | Optional notes |
| `current_round` | INTEGER | Default 1 |
| `software_mentions` | JSONB | Softcite detection results |
| `dataset_mentions` | JSONB | Gemini datasets detection results |
| `materials_mentions` | JSONB | Gemini materials detection results |
| `protocols_mentions` | JSONB | Gemini protocols detection results |
| `authors` | JSONB | ORCID extraction results |
| `created_at` / `updated_at` | TIMESTAMP | Auto-managed |

**Status values**: `draft`, `step_krt`, `step_pdf`, `step_review`, `step_as`, `step_report`, `completed`

**Status transitions**:
```
draft → step_krt → step_pdf → step_review → step_as → step_report → completed
                                                                         ↓
                  ← (can go back to any previous step) ←←←←←←←←←←←←←←←←←
```

**Associations**: has many `File`, `KRTData`, `ValidationResult`, `LMAnalysis`, `ChangeLog`, `Report`, `SubmissionJob`

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
| `round` | INTEGER | |

#### `lm_analyses`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | |
| `status` | ENUM | `queued`, `processing`, `complete`, `failed` |
| `response_data` | JSONB | Raw API response |
| `findings` | JSONB | Structured findings (suggestions) |
| `error_message` | TEXT | |
| `started_at` / `completed_at` | TIMESTAMP | |
| `round` | INTEGER | |
| `source` | STRING | `pdf_analysis`, `software_detection`, etc. |

#### `submission_jobs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | |
| `job_type` | STRING(50) | `das_extraction`, `pdf_analysis`, `markdown_convert`, `software_detection`, `orcid_extraction`, `datasets_detection`, `materials_detection`, `protocols_detection`, `report_generation` |
| `status` | ENUM | `waiting`, `pending_input`, `queued`, `processing`, `complete`, `failed` |
| `pg_boss_job_id` | STRING | pg-boss job reference |
| `reference_id` | UUID | Optional link to related record (e.g., LMAnalysis) |
| `result` | JSONB | Job-specific completion data |
| `error_message` | TEXT | |
| `retry_count` | INTEGER | |
| `round` | INTEGER | |
| `logs` | JSONB | Structured log entries from job execution |
| `raw_responses` | JSONB | Map of `{ name: s3Key }` for raw API response files |
| `started_at` / `completed_at` | TIMESTAMP | |

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `change_logs` | Audit trail for all KRT changes (action, source, metadata) |
| `reports` | Generated reports (type, file URL, Google file ID) |
| `user_hidden_submissions` | Per-user submission visibility preferences |
| `resource_types` | Configurable resource type catalog (name, description, active, sort order) |
| `app_config` | Runtime key-value configuration store (JSONB values) |
| `software_list_entries` | Code/Software enrichment reference list (standardized KRT columns) |
| `materials_list_entries` | Lab materials enrichment reference list (standardized KRT columns) |
| `datasets_list_entries` | Datasets enrichment reference list (standardized KRT columns) |
| `protocols_list_entries` | Protocols enrichment reference list (standardized KRT columns) |

### Enrichment List Tables

All four enrichment list tables (`software_list_entries`, `materials_list_entries`, `datasets_list_entries`, `protocols_list_entries`) share a **standardized schema** matching the KRT columns:

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `resource_type` | STRING(100) | KRT resource type (e.g., "Code/Software", "Dataset", "Antibody") |
| `resource_name` | STRING(500) | Resource name (required) |
| `source` | STRING(500) | URL, vendor, repository |
| `identifier` | STRING(500) | RRID, DOI, catalog number, etc. |
| `new_reuse` | STRING(10) | "new" or "reuse" |
| `additional_information` | TEXT | Free-text extra info |
| `suggested_entity` | STRING(500) | Canonical name for fuzzy matching |
| `tokens` | JSONB | Keyword array for matching (default `[]`) |
| `created_at` / `updated_at` | TIMESTAMP | Auto-managed |

**Indexes**: `resource_type`, `resource_name`

## Migrations

All migrations are in `migrations/` and follow the naming pattern `20250101000XXX-description.js`. They use Sequelize's `queryInterface` for schema changes.

Run migrations:
```bash
npm run migrate           # Apply pending migrations
npm run migrate:undo      # Revert the last migration
```

## pg-boss Schema

The pg-boss job queue creates its own tables under the `pgboss` schema (separate from application tables). This is configured automatically on first start.
