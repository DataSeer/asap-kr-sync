# API Reference

All endpoints are prefixed with `/api`. Authentication is required unless noted otherwise.

## Authentication

### `POST /api/auth/register`
Create a new user account (local auth).
- **Rate limit**: 10 requests / 15 min
- **Body**: `{ email, password, name }`

### `POST /api/auth/login`
Login with email and password.
- **Rate limit**: 10 requests / 15 min (strict brute-force protection)
- **Body**: `{ email, password }`
- **Returns**: `{ token, refreshToken, user }`

### `POST /api/auth/logout`
Invalidate the current session. **Requires auth.**

### `POST /api/auth/refresh`
Refresh an expired access token.
- **Rate limit**: 30 requests / 1 min
- **Body**: `{ refreshToken }`
- **Returns**: `{ token, refreshToken }`

### `GET /api/auth/me`
Get the current authenticated user. **Requires auth.**

### `GET /api/auth/auth0/status`
Check if Auth0 login is enabled. **Public.**

### `GET /api/auth/auth0/login`
Redirect to Auth0 authorization page.

### `POST /api/auth/auth0/login-password`
Auth0 Resource Owner Password Grant.
- **Body**: `{ email, password }`

### `GET /api/auth/auth0/callback`
OAuth2 callback handler. **Public.**

---

## Users (admin / ds_annotator / asap_pm)

### `GET /api/users`
List users with role-based filtering.

### `GET /api/users/:id`
Get a user by ID.

### `POST /api/users`
Create a user. **admin, ds_annotator only.**
- **Body**: `{ email, password, name, role, team }`

### `PATCH /api/users/:id`
Update a user. **admin, ds_annotator only.**

### `DELETE /api/users/:id`
Delete a user. **admin only.**

---

## Teams (admin / ds_annotator)

### `GET /api/teams/codes`
Get active team codes (all authenticated users).

### `GET /api/teams`
List all teams.

### `GET /api/teams/:id`
Get a team by ID.

### `POST /api/teams`
Create a team. **Body**: `{ code, name }`

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
- **asap_pm**: team-scoped
- **admin/ds_annotator**: all

**Query params**: `page`, `limit`, `status`, `team`, `search`

### `GET /api/submissions/hidden`
List submissions hidden by the current user.

### `GET /api/submissions/filter-options`
Get available filter values (teams, users) for the current user's role.

### `POST /api/submissions`
Create a submission.
- **Body**: `{ title, manuscriptId?, notes? }`

### `GET /api/submissions/:id`
Get a submission by ID. **Requires submission access.**

### `PATCH /api/submissions/:id`
Update a submission (title, status, DAS, notes, etc.).

### `DELETE /api/submissions/:id`
Delete a submission. **admin, ds_annotator only.**

### `POST /api/submissions/:id/new-round`
Start a new round (revision) for a submission.

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
Upload a KRT file (CSV, XLSX, XLS, ODS). Max 10MB.
- **Content-Type**: `multipart/form-data` (field: `file`)

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
Upload a supplemental methods file (PDF or Word). Automatically converted to PDF if Word.

---

## PDF Operations

### `POST /api/submissions/:id/pdf/upload`
Upload a manuscript PDF. Max 50MB.

### `GET /api/submissions/:id/pdf/analysis`
Get the current analysis status.

### `GET /api/submissions/:id/pdf/findings`
Get AI-generated findings (suggestions for KRT).

### `POST /api/submissions/:id/pdf/analyze`
Trigger PDF analysis. **Rate limited.**

### `POST /api/submissions/:id/pdf/extract-das`
Extract the Data Availability Statement from the PDF.

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

## ORCID / Authors

### `GET /api/submissions/:id/authors`
Get extracted authors with ORCIDs.
- **Returns**: `{ authors: [...], meta }`

### `POST /api/submissions/:id/authors/extract`
Trigger ORCID extraction (re-run).

---

## Reports

### `POST /api/submissions/:id/reports/generate`
Generate a report (Google Sheets or Excel).
- **Body**: `{ type }` — `google_sheets` or `excel`

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
Get the KRT template URL.

### `GET /api/config/resource-types`
Get valid resource type names.

### `GET /api/config/environment`
Get the current environment label.

---

## Resource Types (admin / ds_annotator)

### `GET /api/resource-types/names`
Get active resource type names (all authenticated users).

### `GET /api/resource-types`
List all resource types with pagination.

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

All four enrichment lists (software, materials, datasets, protocols) share the same CRUD API pattern with standardized KRT column fields: `resourceType`, `resourceName`, `source`, `identifier`, `newReuse`, `additionalInformation`, `suggestedEntity`, `tokens`.

### Software List (`/api/software-list`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | List entries (query: `search`, `page`, `limit`) |
| `GET` | `/:entryId` | Get a single entry |
| `POST` | `/` | Create entry |
| `PATCH` | `/:entryId` | Update entry |
| `DELETE` | `/:entryId` | Delete entry |
| `POST` | `/import` | Bulk import (`{ entries, mode: 'append'|'replace' }`) |
| `GET` | `/export` | Export as CSV |

### Materials List (`/api/materials-list`)

Same endpoints as software list, plus:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/counts` | Entry counts per resource type |
| `GET` | `/export?resourceType=X` | Export filtered by resource type |

### Datasets List (`/api/datasets-list`)

Same endpoints as software list.

### Protocols List (`/api/protocols-list`)

Same endpoints as software list.

---

## Health Check (Public)

### `GET /health`
Returns `200 OK` if the server is running.
