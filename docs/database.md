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
| `deleted` | BOOLEAN | Default `false` — an anonymised account (see below) |
| `deleted_at` | TIMESTAMPTZ | When it was anonymised; NULL otherwise |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

Team membership lives in the `user_teams` junction table — there is no per-user `team` column.

**A user row is never deleted.** `submissions.user_id` and `change_logs.user_id`
are both `ON DELETE CASCADE`, so a real `DELETE` takes the person's manuscripts
with them *and* erases their edits to everyone else's — silently, and with no
tombstone to explain the gap. `DELETE /api/users/:id` therefore anonymises:
random non-routable email, name `Deleted user`, `password_hash` and `auth0_sub`
nulled, `deleted = true`, team memberships removed, live refresh tokens revoked
with reason `account_deleted`.

The flag is not the security boundary — the erased credentials are. `deleted` is
a display and listing concern, and is enforced at exactly two doors that must
stay closed: `middleware/auth.middleware.fetchUserWithTeams` (every
authenticated request, local and Auth0 alike) and the refresh path in
`auth.service`. Adding a third lookup path for users means adding the filter
there too. Pinned by `controllers/users.delete-anonymises.test.js` and
`middleware/auth.middleware.test.js`.

**Associations**: has many `UserTeam`, `Submission`, `ChangeLog`, `UserHiddenSubmission`, `RefreshToken`

#### `teams`

A team is a **lab, identified by its leader's name** (e.g. "Alessi", "Wood") —
**not** the 2-letter code (that is a `project`, see below). The unique `code`
column holds the team name (kept as the key so the FKs below reference it);
`name` is an optional display label.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `code` | VARCHAR(100) | Unique — the team's key (holds the leader name) |
| `name` | VARCHAR(100) | Optional display name |
| `active` | BOOLEAN | Default `true` |

#### `user_teams`

Which users belong to which teams (many-to-many). There is no per-user `team`
column.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `user_id` | UUID (FK) | References `users.id` (cascade) |
| `team` | VARCHAR(100) (FK) | References `teams.code`; unique on `(user_id, team)` |

#### `team_emails`

Admin-managed email→team roster (the **Team Email Assignment** page). Applied on
login/registration to auto-assign a user to a team; an email need not have an
account yet.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `team` | VARCHAR(100) (FK) | References `teams.code` (cascade on delete/rename) |
| `email` | VARCHAR(255) | Lowercased; unique on `(team, email)` |

#### `projects`

ASAP projects — the **2-letter grant codes** (WH, CS, …) that prefix a manuscript
ID. Reference data only: it labels a submission (`submissions.project`) and powers
the dashboard's project filter; it does **not** drive visibility (teams do).
Managed on the **Projects** admin page (CRUD + CSV import/export).

| Column | Type | Notes |
|--------|------|-------|
| `code` | VARCHAR(10) (PK) | The 2-letter grant code |
| `pi_name` | VARCHAR(255) | Principal investigator (optional) |
| `title` | TEXT | Grant title (optional) |
| `active` | BOOLEAN | Default `true` |

#### `submissions`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | Auto-generated |
| `user_id` | UUID (FK) | Owner — cascades on delete |
| `project` | VARCHAR(10) | 2-letter grant code auto-extracted from `manuscript_id`; not FK-validated. Filter/label only — does not drive visibility (owner's teams do). |
| `title` | VARCHAR(500) | Required |
| `manuscript_id` | VARCHAR(100) | Optional, validated against the ASAP pattern |
| `data_availability_statement` | TEXT | The statement the submission **stands on**. Filled from extraction *only while empty*; once it holds anything it belongs to whoever put it there. `"Not found"` counts as empty. |
| `extracted_data_availability_statement` | TEXT | What the **last extraction** found. Always overwritten — it is a record of what the extractor said, not of what the submission claims. |
| `das_confirmed_at` | TIMESTAMPTZ | When somebody vouched for the statement. The Availability check will not run without it. Cleared when extraction rewrites the field, and on a new round. |
| `das_confirmed_by_user_id` | UUID (FK) | Who vouched for it. Set by `POST /:id/das/confirm`, and by writing the statement — authoring it says the same thing. |
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
| `triggered_by_user_id` | UUID (FK, nullable) | Who asked for this step to run — **not** the submission's owner. `ON DELETE SET NULL`, though accounts are anonymised rather than deleted so it should never fire. NULL means the row predates the column or no user was involved. |
| `run_count` | INTEGER | How many times this step has run in this round. Denormalised from `submission_job_runs` so the panel can say "run 3" without an aggregate on a table polled every few seconds. |
| `started_at` / `completed_at` | TIMESTAMPTZ | |

#### `submission_job_runs`

The history beside `submission_jobs`. **One row per run**, where the job row is
only ever the *current* run — reused on every re-run, which is the rival-row fix
and must not change.

History must never be written as extra `submission_jobs` rows:
`getForSubmission` keeps the newest row per job type, so a second row hides the
pipeline's own and the advancement that should follow lands on the wrong one.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_job_id` | UUID (FK) | Cascades. `UNIQUE (submission_job_id, run_number)` |
| `submission_id`, `job_type`, `round` | | Denormalised, so history is queryable without a join |
| `run_number` | INTEGER | 1-based per (submission, job_type, round); allocated in the INSERT |
| `status` | ENUM | This run's terminal status — its own enum type, distinct from `submission_jobs.status` |
| `outcome_state` / `outcome_source` / `fail_reason` / `external_error` | | The service snapshot, flattened so it can be filtered on. `outcome_state` includes `partial` |
| `triggered_by_user_id` | UUID (FK, nullable) | Who asked. `ON DELETE SET NULL` |
| `trigger_kind` | VARCHAR(16) | `manual` \| `pipeline` \| `reconciler` |
| `started_at` / `completed_at` / `duration_ms` | | `duration_ms` is stored rather than derived, so a later purge of timestamps cannot take it too |
| `retry_count` | INTEGER | pg-boss attempts **within** this run — a retry is not a new run |
| `counts` / `result` / `logs` / `inputs` | JSONB | The payload. **Nullable on purpose**: the record above is small and kept forever, the payload can be pruned without losing the history |
| `s3_prefix` | TEXT | Where this run's artefacts live |

#### `submission_input_freezes`

What one round is being processed from. **One row per (submission, round, input
kind)**, created by the FIRST step that reads that input; every later reader in
the round is handed the same thing.

Before this, nine services each ran their own `File.findOne({ type }, order:
version DESC)`, so "the input" meant whatever was newest when each step happened
to run. Replacing a file mid-run split the round, and nothing recorded it. See
[background-jobs.md](./background-jobs.md#one-round-one-pdf-one-krt).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID (PK) | |
| `submission_id` | UUID (FK) | Cascades |
| `round` | INTEGER | |
| `input_kind` | VARCHAR(32) | `pdf` \| `markdown` \| `krt`. Not an enum: adding a kind should not need a migration that rewrites a type |
| `file_id` | UUID (FK, nullable) | File inputs, **by reference** — a File row is immutable once written. `ON DELETE SET NULL` |
| `file_version` / `s3_key` / `bytes` | | Copied rather than joined, so "what did this run read" survives the file row being removed |
| `sha256` | VARCHAR(64) | Unused here — hashing would mean downloading the object just to freeze a reference. The column exists for run inputs, which hash the buffer anyway |
| `payload` | JSONB | Row inputs, **by value**. The KRT only: `krt_data` rows are the live editing surface and have no version to point at, so the snapshot IS the reference |
| `row_count` | INTEGER | What `stale` is computed from. A count cannot see an edited cell, and the app says only what it can stand behind |
| `frozen_by_job_type` | VARCHAR(64) | Which step read it first. For the re-freeze rule, not for display |
| `frozen_at` | TIMESTAMPTZ | |

`UNIQUE (submission_id, round, input_kind)` is load-bearing: two detectors
starting in the same millisecond both find no freeze and both try to create one.
The constraint decides, and the loser takes the winner's answer — the point is
that the round agrees on one input, not that a particular step wins.

### Supporting Tables

| Table | Purpose |
|-------|---------|
| `change_logs` | Audit trail for all KRT changes (action, source, metadata). `file_id` ties an upload entry to the exact file version it describes — before it, the narrative and the file could only be matched by timestamp |
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
