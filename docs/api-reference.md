# API Reference

All endpoints are prefixed with `/api`. Authentication is required unless noted otherwise.

Authentication is **cookie-based** since Phase 6: the backend sets three cookies (`asap_kr_session` access JWT, `asap_kr_refresh` refresh JWT, `asap_kr_csrf` CSRF double-submit token) and reads the session cookie on every authenticated request. Clients must send requests with credentials (`withCredentials: true` for axios) and echo the CSRF token in the `X-CSRF-Token` header on every state-changing call. No `Authorization: Bearer` header support.

## Authentication

### `POST /api/auth/register`
Create a new user account (local auth). Gated by `SIGNUP_ENABLED=true` (else 403).
- **Rate limit**: 10 requests / 15 min
- **Body**: `{ email, password, name, role?, team? }` — password ≥ 8 chars with at least one letter and digit; `team` required when `role=asap_pm`.
- **Returns**: `201 { message, user }`. Sets `asap_kr_session`, `asap_kr_refresh`, `asap_kr_csrf` cookies.
- **CSRF**: exempt (bootstraps the CSRF cookie).

### `POST /api/auth/login`
Login with email and password.
- **Rate limit**: 10 requests / 15 min (strict brute-force protection)
- **Body**: `{ email, password }`
- **Returns**: `200 { message, user }`. Sets the three auth cookies.
- **CSRF**: exempt.

### `POST /api/auth/logout`
Revoke all live refresh tokens for the current user and clear all three cookies. **Requires auth.**
- **Returns**: `{ message, auth0LogoutUrl? }` — `auth0LogoutUrl` is present when the user has `auth0Sub` and Auth0 is configured.

### `POST /api/auth/refresh`
Rotate the access + refresh tokens. Reads the `asap_kr_refresh` cookie; **no body required**.
- **Rate limit**: 30 requests / 1 min
- **Returns**: `{ message: 'Refreshed' }`. Sets fresh `asap_kr_session`, `asap_kr_refresh`, and a regenerated `asap_kr_csrf` cookie.
- **CSRF**: exempt (rotates the CSRF cookie itself).

### `GET /api/auth/me`
Get the current authenticated user. **Requires auth.**
- **Returns**: `{ user: { id, email, name, role, auth0Sub, teams[] } }`.

### `GET /api/auth/auth0/status`
Check if Auth0 login is enabled. **Public.** Returns `{ enabled: boolean }`.

### `GET /api/auth/auth0/login?connection=google-oauth2|ORCID`
Build the Auth0 authorize URL (with PKCE + state + nonce flow cookies) and redirect to it.
- **Rate limit**: 10 requests / 15 min
- **400** if `connection` missing; **502** if Auth0 not configured.

### `POST /api/auth/auth0/login-password`
Auth0 Resource Owner Password Grant. Backend proxies credentials to Auth0, verifies the ID token, links/creates the local user, then mints a local JWT pair.
- **Rate limit**: 10 requests / 15 min
- **Body**: `{ email, password }`
- **Returns**: `{ message, user }`. Sets the three auth cookies. Auth0 tokens never leave the backend.
- **CSRF**: exempt.

### `GET /api/auth/callback`
Canonical Auth0 OAuth callback handler. Validates state + nonce, exchanges the code (PKCE), mints a local JWT pair, sets cookies, then redirects 302 to `{FRONTEND_URL}/dashboard` (clean URL — no token in hash). **Public.**

### `GET /api/auth/auth0/callback`
Legacy alias for `/api/auth/callback`, kept for backward compatibility with the Auth0 dashboard's allowed-callbacks list. **Public.**

---

## Users (admin / ds_annotator / asap_pm)

### `GET /api/users`
List users with role-based filtering.

### `GET /api/users/:id`
Get a user by ID.

### `POST /api/users`
Create a user. **admin, ds_annotator only.** Non-admins cannot create admin-role users.
- **Body**: `{ email, password, name, role, teams?: string[] }` — `teams` is an array (max 50), defaulting to `[]`.

### `PATCH /api/users/:id`
Update a user. **admin, ds_annotator only.** Body accepts any of `name, role, password, teams[]` (at least one required). Non-admins cannot edit existing admin users or promote anyone to admin. Replaces the full team list when `teams` is provided.

### `DELETE /api/users/:id`
Delete a user. **admin only.** Self-deletion is blocked (400).

---

## Teams (admin / ds_annotator)

### `GET /api/teams/codes`
Get active team codes (all authenticated users).

### `GET /api/teams`
List all teams.

### `GET /api/teams/:id`
Get a team by ID.

### `POST /api/teams`
Create a team.
- **Body**: `{ code, name? }` — `code` is 1-32 chars matching `^[A-Z0-9_-]+$` (auto-uppercased); `name` is optional, max 255 chars.

### `PATCH /api/teams/:id`
Update a team.

### `DELETE /api/teams/:id`
Delete a team.

---

## Profile

### `GET /api/profile`
Get current user's profile.

### `PATCH /api/profile`
Update profile (name, password change).

---

## Submissions

### `GET /api/submissions`
List submissions. Filtered by role:
- **author**: own submissions only
- **asap_pm**: team-scoped (own teams; or `team IS NULL` if PM has no teams)
- **admin/ds_annotator**: all

**Query params**: `page` (default 1, max 100), `limit` (default 20, max 100), `sort` (`createdAt|updatedAt|title|status`, default `createdAt`), `order` (`ASC|DESC`, default `DESC`), `status` (comma-separated), `team` (comma-separated), `userId` (comma-separated), `visibility` (`visible|hidden|all`, default `visible`).

### `GET /api/submissions/hidden`
List submissions hidden by the current user.

### `GET /api/submissions/filter-options`
Get available filter values (teams, users) for the current user's role.

### `POST /api/submissions`
Create a submission.
- **Body**: `{ title, manuscriptId?, dataAvailabilityStatement?, notes? }` — `title` 1-500 chars (required); `manuscriptId` must match `^[A-Z]{2}\d-\d{6}-\d{3}-org-[A-Z]-\d$` if provided (team auto-derived from it).

### `GET /api/submissions/:id`
Get a submission by ID. **Requires submission access.**

### `PATCH /api/submissions/:id`
Update a submission (title, status, DAS, notes, etc.).

### `DELETE /api/submissions/:id`
Delete a submission. **admin, ds_annotator only.**

### `POST /api/submissions/:id/new-round`
Start a new round (revision) for a submission. The submission must be at `step_report` or `completed`.
- **Body**: `{ hasNewKRT: boolean }` (required) — when `true`, the user lands at `step_krt` to upload a fresh KRT; when `false`, the current KRT is carried forward and the user lands at `step_pdf`.

### `POST /api/submissions/:id/hide`
Hide a submission from the current user's dashboard.

### `POST /api/submissions/:id/unhide`
Unhide a previously hidden submission.

### `GET /api/submissions/:id/changes`
Get the change history (audit log) for a submission.

---

## Files

### `GET /api/submissions/:id/files/:fileId/download`
Get a presigned S3 download URL for a file.

---

## KRT Operations

### `POST /api/submissions/:id/krt/upload`
Upload a KRT file (CSV or XLSX only — legacy `.xls`/`.ods` are not supported). Max 10MB.
- **Content-Type**: `multipart/form-data` (field: `file`)
- **Rate-limited** via `uploadLimiter` (20 / min / user).

### `GET /api/submissions/:id/krt`
Get KRT data (rows + validation errors).

### `PATCH /api/submissions/:id/krt/:rowId`
Update a KRT row cell.
- **Body**: `{ column, value, source? }`

### `POST /api/submissions/:id/krt/row`
Add a new KRT row.
- **Body**: `{ resourceType, resourceName, source, identifier, newReuse, additionalInformation }`

### `DELETE /api/submissions/:id/krt/:rowId`
Delete a KRT row.

### `POST /api/submissions/:id/krt/validate`
Re-validate all KRT data.

### `GET /api/submissions/:id/krt/download`
Download the corrected KRT as a file.

---

## Supplemental Files

### `POST /api/submissions/:id/supplemental/upload`
Upload a supplemental methods file (PDF, DOC, or DOCX). Max 50MB. Word files are stored alongside an auto-converted PDF (`supplemental_pdf` file type).

---

## PDF Operations

### `POST /api/submissions/:id/pdf/upload`
Upload a manuscript PDF (or DOCX). Max 50MB. Triggers the full background-job pipeline (`orchestrator.runAllProcesses`) automatically after upload.

### `GET /api/submissions/:id/pdf/analysis`
Get the current PDF Analysis (consolidator) job status.

### `GET /api/submissions/:id/pdf/findings`
Get the unified suggestions list once PDF Analysis is complete.

### `POST /api/submissions/:id/pdf/analyze`
Re-trigger PDF Analysis (the in-app consolidator). Rate-limited via `lmApiLimiter` (10 / min / user).

### `POST /api/submissions/:id/pdf/extract-das`
Re-trigger DAS extraction from the latest PDF.

---

## Suggestions

### `GET /api/submissions/:id/suggestions`
Get all pending suggestions (unified from all sources: PDF analysis, software detection, etc.).

### `POST /api/submissions/:id/suggestions/approve`
Approve a suggestion (applies the change to the KRT).
- **Body**: `{ suggestionId }`

### `POST /api/submissions/:id/suggestions/reject`
Reject a suggestion.
- **Body**: `{ suggestionId }`

---

## Software Detection

### `GET /api/submissions/:id/software`
Get detected software mentions.
- **Returns**: `{ mentions: [...], meta }`

### `POST /api/submissions/:id/software/detect`
Trigger software detection (re-run).

---

## Datasets Detection

### `GET /api/submissions/:id/datasets`
Get detected dataset mentions.
- **Returns**: `{ mentions: [...], meta }`

### `POST /api/submissions/:id/datasets/detect`
Trigger datasets detection (re-run).

---

## Materials Detection

### `GET /api/submissions/:id/materials`
Get detected materials mentions.
- **Returns**: `{ mentions: [...], meta }`

### `POST /api/submissions/:id/materials/detect`
Trigger materials detection (re-run).

---

## Protocols Detection

### `GET /api/submissions/:id/protocols`
Get detected protocols mentions.
- **Returns**: `{ mentions: [...], meta }`

### `POST /api/submissions/:id/protocols/detect`
Trigger protocols detection (re-run).

---

## Identifier Detection

### `GET /api/submissions/:id/identifiers`
Get matches from the curated enrichment-list scan (cross-category — software, datasets, materials, protocols in one pass).
- **Returns**: `{ mentions: [...], meta }`

### `POST /api/submissions/:id/identifiers/detect`
Trigger identifier detection (re-run). Cascade-restarts PDF Analysis.

---

## Markdown Convert

### `POST /api/submissions/:id/markdown/convert`
Re-trigger PDF → Markdown conversion. Cascade-restarts Datasets / Protocols / Identifier Detection / PDF Analysis.

---

## ORCID / Authors

### `GET /api/submissions/:id/authors`
Get extracted authors with ORCIDs.
- **Returns**: `{ authors: [...], meta }`

### `POST /api/submissions/:id/authors/extract`
Trigger ORCID extraction (re-run).

---

## Reports

### `POST /api/submissions/:id/reports/generate`
Generate a report. Submission must be at `step_report` or `completed`.
- **Body**: `{ type }` — `excel` (default) or `pdf`. Google Sheets export is reserved but not yet implemented.

### `GET /api/submissions/:id/reports`
List all reports for a submission.

### `GET /api/submissions/:id/reports/:reportId`
Get a specific report.

### `GET /api/submissions/:id/reports/:reportId/download`
Get a presigned download URL for a report.

---

## Background Jobs

All job endpoints support an optional `?round=N` query parameter. When omitted, defaults to the submission's current round.

### `GET /api/submissions/:id/jobs?round=N`
Get all background job statuses for a submission.
- **Returns**: `{ round, jobs: [...] }` — each job includes `logs`, `rawResponses`, `result`, `config`

### `POST /api/submissions/:id/processes/run`
Run (or re-run) all background processes for a submission.

### `POST /api/submissions/:id/jobs/:jobType/advance?round=N`
Manually advance a `pending_input` job to `queued`.

### `GET /api/submissions/:id/jobs/:jobType/responses/:responseName?round=N`
Get a presigned S3 download URL for a job's raw API response file.
- **Returns**: `{ url, name, s3Key, round }`

---

## Configuration (Public)

### `GET /api/config/krt-template`
Get the KRT template URL. Returns `{ url }`.

### `GET /api/config/resource-types`
Get valid resource type names from the DB-backed catalog.

### `GET /api/config/environment`
Get the current environment label and signup flag. Returns `{ environment, signupEnabled }`.

### `GET /api/config/services`
Get the runtime state of every background service. Returns `{ services: { das_extraction, pdf_analysis, software_detection, orcid_extraction, markdown_convert, datasets_detection, materials_detection, protocols_detection, identifier_detection } }` — each entry is `{ state: 'on' | 'demo' | 'off', enabled: boolean, hasDemoData: boolean }`. The ORCID entry also exposes `subServices.{grobid, openalex, orcid_api}`.

---

## Resource Types (admin / ds_annotator)

### `GET /api/resource-types/names`
Get active resource type names (all authenticated users).

### `GET /api/resource-types`
List all resource types with pagination. Query: `page`, `limit`, `active`.

### `GET /api/resource-types/export`
Export the active resource types as CSV (`text/csv`, filename `resource-types.csv`).

### `POST /api/resource-types/import`
Bulk import resource types. Body: `{ entries: [{ name, type?, description?, sortOrder?, active? }], mode: 'append' | 'replace' }`. Returns `201 { imported, mode, previouslyDeleted? }`.

### `POST /api/resource-types`
Create a resource type.

### `PATCH /api/resource-types/:id`
Update a resource type.

### `DELETE /api/resource-types/:id`
Delete a resource type.

---

## App Config (admin only)

### `GET /api/app-config`
List all configuration entries.

### `GET /api/app-config/:key`
Get a config value by key.

### `PUT /api/app-config`
Create or update a config entry.
- **Body**: `{ key, value, description?, category? }`

### `DELETE /api/app-config/:key`
Delete a config entry.

---

## Enrichment Lists (admin / ds_annotator)

All four curated lists (software, materials, datasets, protocols) live in a **single** `enrichment_list_entries` table with a `category` column. The HTTP surface uses one base path with `:category` ∈ `{software, materials, datasets, protocols}`. Standardized fields per entry: `resourceType`, `resourceName`, `source`, `identifier`, `newReuse`, `additionalInformation`, `suggestedEntity`, `tokens`.

### Cross-category

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/enrichment-list` | List entries across categories. Query: `category?`, `search?`, `resourceType?`, `page` (default 1), `limit` (default 50, max 100). Returns `{ entries, total, page, totalPages }`. |
| `GET` | `/api/enrichment-list/_counts` | Per-category entry counts: `{ software, materials, datasets, protocols, total }`. |

### Per-category (`/api/enrichment-list/:category`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List entries in this category (same query params as cross-category, minus `category`). |
| `GET` | `/counts` | Entry counts per `resourceType` within the category. |
| `GET` | `/export?resourceType=X` | Export as CSV. Filename `${category}-list.csv` (or `${category}-${resourceType}.csv` when filtered). |
| `POST` | `/import` | Bulk import. Body: `{ entries[], mode: 'append'|'replace', resourceType?: string }`. Returns `201 { imported, mode, previouslyDeleted? }`. |
| `GET` | `/:entryId` | Get a single entry. |
| `POST` | `/` | Create entry. |
| `PATCH` | `/:entryId` | Update entry (at least one field required). |
| `DELETE` | `/:entryId` | Delete entry. |

Invalid `:category` values are rejected with 400.

---

## Demos (any authenticated user)

### `GET /api/demos`
List the demo submissions available on this deployment. Returns `{ demos: [{ id, name, description, pdf, krt }] }`, built from a filesystem scan of `src/frontend/public/demo-files/` plus matching JSON findings under `src/backend/data/demo-findings/`. The accompanying demo binaries themselves are served as static assets under `/demo-files/*`.

---

## Health Check (Public)

### `GET /health`
Returns `200 OK` if the server is running. Mounted at the **root**, not under `/api`.
