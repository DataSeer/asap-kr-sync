# API Reference

All endpoints are prefixed with `/api`. Authentication is required unless noted otherwise.

Authentication is **cookie-based** since Phase 6: the backend sets three cookies (`asap_kr_session` access JWT, `asap_kr_refresh` refresh JWT, `asap_kr_csrf` CSRF double-submit token) and reads the session cookie on every authenticated request. Clients must send requests with credentials (`withCredentials: true` for axios) and echo the CSRF token in the `X-CSRF-Token` header on every state-changing call. No `Authorization: Bearer` header support.

## Authentication

### `POST /api/auth/register`
Create a new user account (local auth). Gated by `SIGNUP_ENABLED=true` (else 403).
- **Rate limit**: 10 requests / 15 min
- **Body**: `{ email, password, name }` — password ≥ 8 chars with at least one letter and digit. `role` and `team` are **not** accepted on self-signup (dropped by `stripUnknown`; role is forced to `author`). Roles and team membership are assigned only through the admin user-management endpoints.
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

`password` is **admin only** — a 403 for anyone else, even on a user they may
otherwise edit. Whoever sets a password knows it and can then sign in as that
person, so this is account takeover rather than a lesser form of editing; every
other field here is recoverable. Setting it also revokes all of the target's
sessions. Users change their own password through `PATCH /api/profile`, which
requires the current one. Creating a user with an initial password is not
affected — that starts an account rather than seizing one.

### `DELETE /api/users/:id`
Delete a user. **admin only.** Self-deletion is blocked (400); an
already-deleted user is a 409.

**This anonymises rather than removes.** The row survives so that the user's
submissions and their edits to other people's submissions survive with it
(both FKs cascade). The identity does not: the email is replaced with a random
`@deleted.invalid` address, the name becomes `Deleted user`, the password hash
and Auth0 link are nulled, team memberships are dropped and live refresh tokens
are revoked, all in one transaction. The account is then absent from
`GET /api/users`, and `GET`/`PATCH /api/users/:id` return 404 for it.

---

## Teams (admin / ds_annotator)

A **team** is a lab keyed by its `code` (which holds the leader's name, e.g.
"Alessi"). This is distinct from a **project** (a 2-letter grant code — see the
Projects section).

### `GET /api/teams/codes`
Get active team codes/keys (all authenticated users).

### `GET /api/teams`
List all teams.

### `GET /api/teams/:id`
Get a team by ID.

### `POST /api/teams`
Create a team.
- **Body**: `{ code, name? }` — `code` is 1-100 chars (the team key / leader name); `name` is an optional display label, max 255 chars.

### `PATCH /api/teams/:id`
Update a team. **Body**: any of `{ code, name, active }` (at least one).

### `DELETE /api/teams/:id`
Delete a team. Refused with a 400 while the team still has members — that is the
only thing attaching anything to a team, since a submission carries a *project*
and an owner, and team visibility is derived from the owner's memberships.

### `GET /api/teams/export`
Download all teams as CSV (`code,name,active`), re-importable via import.

### `POST /api/teams/import`
Upsert teams from parsed CSV rows.
- **Body**: `{ teams: [{ code, name?, active? }] }` — 1-10000 rows. `code` is the team key (lab leader name, ≤100 chars) and accepts a `team` alias; existing codes are updated (name/active only — import never renames), new ones created; rows with a blank/too-long code are skipped.
- **Returns**: `{ created, updated, invalid[] }`.

### Team-email roster (auto-assignment)

An admin-managed email→team roster (`team_emails`, surfaced as the **Team Email
Assignment** page). On sign-in a user's teams are auto-derived from this list.
All roster endpoints are **admin / ds_annotator / asap_pm**.

#### `GET /api/teams/email-mappings`
List `(id, team, email)` mappings. Query: `search?`, `team?`, `page?`, `limit?`.

#### `GET /api/teams/email-mappings/export`
Download the full roster as CSV (`team,email`), re-importable via the create endpoint.

#### `POST /api/teams/email-mappings`
Bulk-create mappings (used by CSV import).
- **Body**: `{ mappings: [{ team, email }] }` — 1-2000 items; `email` lowercased and validated; `team` 1-100 chars. Duplicates on `(team, email)` are ignored. An email need not have an account yet.

#### `DELETE /api/teams/email-mappings/:id`
Delete a single mapping.

---

## Projects (admin / ds_annotator)

A **project** is a 2-letter ASAP grant code (WH, CS, …) — the manuscript-ID
prefix stored on `submissions.project`. Reference data that labels submissions
and powers the dashboard's project filter; it does **not** affect visibility.

### `GET /api/projects/codes`
Active project codes (all authenticated users; for dropdowns).

### `GET /api/projects`
List projects. Query: `page?`, `limit?`, `active?`.

### `POST /api/projects`
Create a project. **Body**: `{ code, piName?, title?, active? }` — `code` must match `^[A-Z0-9]{2}$` (exactly 2 chars, auto-uppercased).

### `PATCH /api/projects/:code`
Update a project. **Body**: any of `{ piName, title, active }`.

### `DELETE /api/projects/:code`
Delete a project (removes the reference entry only).

### `GET /api/projects/export`
Download all projects as CSV (`code,piName,title,active`), re-importable via import.

### `POST /api/projects/import`
Upsert projects from parsed CSV rows.
- **Body**: `{ projects: [{ code, piName?, title?, active? }] }` — 1-10000 rows. Existing codes are updated, new ones created; rows whose `code` isn't a valid 2-char code are skipped.
- **Returns**: `{ created, updated, invalid[] }`.

---

## Profile

### `GET /api/profile`
Get current user's profile.

### `PATCH /api/profile`
Update profile (name, password change).

---

## Submissions

### `GET /api/submissions`
List submissions. Filtered by role (visibility is owner-team based — see
`roles-and-permissions.md`):
- **author**: own submissions only
- **asap_pm**: own, plus submissions whose **owner shares one of the PM's teams** (staff-owned excluded)
- **admin/ds_annotator**: all

**Query params**: `page` (default 1, max 100), `limit` (default 20, max 100), `sort` (`createdAt|updatedAt|title|status`, default `createdAt`), `order` (`ASC|DESC`, default `DESC`), `status` (comma-separated), `project` (comma-separated grant codes, e.g. `WH,ML` — filter/label only, never widens visibility), `userId` (comma-separated), `visibility` (`visible|hidden|all`, default `visible`).

### `GET /api/submissions/hidden`
List submissions hidden by the current user.

### `GET /api/submissions/filter-options`
Get available filter values (distinct **projects** and users among visible submissions) for the current user's role.

### `PATCH /api/submissions/:id/owner`
Reassign a submission's owner. **admin, ds_annotator only.** After reassignment the submission follows the new owner's teams (used to hand a staff-uploaded PDF to the real author).
- **Body**: `{ userId }` (UUID of the new owner).

### `POST /api/submissions`
Create a submission.
- **Content-Type**: `multipart/form-data` (rate-limited by `uploadLimiter`).
- **File field `krt`** (CSV/XLSX): the Key Resources Table. **Strongly recommended at creation time, but optional** — a submission can be started without it and the KRT added later. When provided, its column format is validated server-side before any DB write (a 400 is returned if the format is invalid). When omitted, the frontend shows a confirmation modal and submits a header-only empty KRT; the PDF analysis pipeline starts regardless, and the user can upload the real KRT afterwards (Step 1 / `POST /api/submissions/:id/krt/upload`).
- **Other form fields**: `title` 1-500 chars (required); `manuscriptId` (optional; must match `^[A-Z]{2}\d-\d{6}-\d{3}-org-[A-Z]-\d$` if provided); `dataAvailabilityStatement?`, `notes?`. _(Note: the current create UI does not collect `manuscriptId` — it is set later via Edit Metadata.)_
- The submission is created directly at status `step_krt`.

### `GET /api/submissions/:id`
Get a submission by ID. **Requires submission access.**

### `PATCH /api/submissions/:id`
Update a submission (title, status, DAS, notes, etc.).

Changing `dataAvailabilityStatement` **confirms it in the caller's name** and
releases the Availability check: a person writing the statement has vouched for
it, and asking them to confirm a sentence they just typed is a dialog people
learn to dismiss. Re-saving the same text is not a change, so it does not
re-stamp the confirmation — that would credit the wrong person with the
decision. Emptying the field clears the confirmation instead.

### `DELETE /api/submissions/:id`
Delete a submission. **admin, ds_annotator only.**

### `POST /api/submissions/:id/new-round`
Start a new round (revision) for a submission. The submission must be at `step_report` or `completed`.
- **Body**: `{ hasNewKRT: boolean }` (required) — when `true`, the user lands at `step_krt` to upload a fresh KRT; when `false`, the current KRT is carried forward and the user lands at `step_pdf`.
- Clears `dataAvailabilityStatement`, `extractedDataAvailabilityStatement` and
  the confirmation: they were about the previous manuscript.

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

- **Returns**: `{ rows: KrtRow[], validationErrors, totalErrors, totalWarnings }`

A **KRT row** (`KrtRow`) is the display shape produced by `KRTData.prototype.toKRTRow()`
(`src/backend/models/KRTData.js`). The six visible columns use **uppercase display keys**;
metadata fields use camelCase:

```jsonc
{
  "id": "a1b2c3d4-...",            // UUID of the krt_data row
  "RESOURCE TYPE": "Software/code",
  "RESOURCE NAME": "Python",
  "SOURCE": "https://python.org",
  "IDENTIFIER": "RRID:SCR_008394",
  "NEW/REUSE": "reuse",           // "new" | "reuse" | ""
  "ADDITIONAL INFORMATION": "",   // free text; user-owned
  "parsedIdentifiers": {},         // structured identifier components (JSONB)
  "round": 1,
  "originRowId": null,             // self-ref to the source row on round copies, else null
  "addedByTool": false,            // true iff inserted by an accepted AI add_row suggestion
  "isQc": false,                   // QC flag — admin / ds_annotator only (see note)
  "isOptional": false              // Optional flag — admin / ds_annotator only (see note)
}
```

> `isQc` / `isOptional` (DB columns `krt_data.is_qc` / `is_optional`) are **role-gated**: only Administrator and
> DS Annotator can see or edit them. The `PATCH .../krt/:rowId` endpoint rejects these columns from regular users
> (author, asap_pm).

> The persisted DB columns (snake_case: `resource_type`, `new_reuse`, `additional_information`, …)
> are documented in [database.md → `krt_data`](./database.md#krt_data). `toKRTRow()` is the mapping
> from those columns to the uppercase API shape above; `addedByTool` is computed per request from the
> change log (not a stored column).

The response also includes `validationErrors` (an object keyed by row `id`, each value an array of
`{ column, type, message, severity, suggestion, suggestedValue }`), plus `totalErrors` and `totalWarnings`
counts. `suggestedValue` (DB column `validation_results.suggested_value`, nullable) is a machine-actionable
value the editor uses to group resource-type errors into one-click bulk fixes (e.g. "Set 4 → Software/code");
`normalizeResourceType` also maps variants such as Mouse / Virus Strain to the canonical type.

### `PATCH /api/submissions/:id/krt/:rowId`
Update a single KRT row cell.
- **Body**: `{ column, value, source? }`

### `PATCH /api/submissions/:id/krt/batch`
Batch-update KRT cells in **one transaction** — the editor routes both single edits and bulk gestures
(apply-all validation fixes, multi-cell edits) through here instead of looping one request per cell, so a
large "fix all" no longer trips the rate limit.
- **Body**: `{ updates: [ { rowId, column, value } … ] (1–500 items), source? }`
- `column` is a strict allowlist (`resource_type`, `resource_name`, `source`, `identifier`, `new_reuse`,
  `additional_information`, `is_qc`, `is_optional`); `is_qc`/`is_optional` remain role-gated to Admin / DS Annotator.
- All items apply together with per-item ChangeLog entries and a single post-commit validation pass; a `rowId`
  belonging to another submission fails the **whole** batch (404) rather than being silently skipped.
- **Returns**: the updated rows plus the same validation summary as `POST …/krt/validate`.

> **Route order:** `/krt/batch` is registered before the parameterized `/krt/:rowId` so "batch" is not captured as a row id.

### `POST /api/submissions/:id/krt/row`
Add a new KRT row.
- **Body**: `{ resourceType, resourceName, source, identifier, newReuse, additionalInformation }`

### `DELETE /api/submissions/:id/krt/:rowId`
Delete a KRT row.

### `POST /api/submissions/:id/krt/merge`
Merge two or more KRT rows into one. The client picks each column's value to keep; the server performs a
**transactional** bulk delete of the selected rows plus creation of the single merged row.
- **Body**: the selected row ids and the chosen per-column values for the merged row.

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
Get the current PDF Analysis (Generated-KRT builder) job status.

### `GET /api/submissions/:id/pdf/findings`
Get the unified suggestions list once PDF Analysis is complete.

### `POST /api/submissions/:id/pdf/analyze`
Re-run the PDF Analysis step (the Generated-KRT builder: rule-based merge → LM
consolidation). Rate-limited via `lmApiLimiter` (10 / min / user).

Re-runs it **in the pipeline**: the round's existing `pdf_analysis` row is
reused, and it only starts once every detector has finished and the gates pass —
otherwise it stays `waiting` for the orchestrator to advance. It does not create
a second job row, and it cannot jump ahead of the detectors it consolidates.

### `POST /api/submissions/:id/pdf/extract-das`
Re-run DAS extraction **as a pipeline step**, and return immediately (202).
- **Returns**: `{ message, status, submissionJobId }`
- ⚠️ **Clears `dataAvailabilityStatement` first.** Asking for extraction again is
  asking for a fresh reading of the manuscript, and the working field is only
  filled while it is empty — without the reset the module would run and change
  nothing visible. Any statement a person wrote is discarded by this call; the
  previous extraction survives in `extractedDataAvailabilityStatement`.
- It used to run the extraction inside the request. That worked, but left the
  pipeline untouched: the `das_extraction` job row kept the previous run's
  status, result, frozen inputs and prompt — so the module page described a run
  that was no longer the latest — and nothing downstream re-ran, so
  consolidation and the Availability check kept answers built from a statement
  that had just been replaced.

---

## Suggestions

### `GET /api/submissions/:id/suggestions`
Get all pending AI Suggestions.

- **Returns**: `{ suggestions: Suggestion[] }`

Suggestions are **persisted**, not diff-computed at read time. They are produced by the dedicated
**`suggestion_generation`** pipeline step (AI Suggestions / KRT Comparison): a Gemini call compares the author
KRT against the **Generated KRT** and emits, for every generated resource, a decision (add / skip / update /
remove) with a reason, plus author-side fixes (see
[pipeline-modules.md §3.10](./pipeline-modules.md#310-suggestion_generation--ai-suggestions-krt-comparison)).
The module is **LM-only — with no LM configured, no suggestions are produced.** Because the list is persisted on
the job result, editing the KRT does **not** silently change it; suggestions change only when the job is re-run
(the "Regenerate suggestions" button → `POST /api/submissions/:id/suggestions/regenerate`, or a module restart
cascading through). `read`/`approve`/`reject` operate on the persisted list; **accepting a `remove` deletes the
KRT row.** Each suggestion carries its real contributing detection module(s)
(software/datasets/materials/protocols/identifier) as origin badges. Built in
`src/backend/services/suggestion/kr-comparison.service.js`. *(The old read-time diff
`src/backend/services/pdf-analysis/diff-suggestions.service.js` is retired in production but kept in the repo.)*

IDs remain **deterministic**, derived from the resource's `dedupKey` (`identifier|resourceType|newReuse`), so the
same resource yields a stable suggestion id. There are two pending shapes (`add_row`, `edit`) plus a `rejected`
view of either.

**`add_row`** — propose inserting a new resource row:

```jsonc
{
  "id": "add:rrid:scr_008394|Software/code|reuse",  // "add:<dedupKey>"
  "type": "add_row",
  "action": "add_row",
  "status": "pending",
  "source": "pdf_analysis",
  "title": "Python",
  "description": "Add Software/code: Python",
  "detail": "…manuscript excerpt / detector context…",  // for the details panel; may be null
  "evidence": "…extracted text from detectedBy entries…", // legacy tooltip; may be null
  "context": "…detector blurb…",   // UI-only hint, NOT persisted to the KRT
  "confidence": 0.8,                // 0..1, max across contributing detectors
  "existsInKRT": "false",
  "matchedKrtRowId": null,
  "data": {                          // the row that gets written on approve
    "resourceType": "Software/code",
    "resourceName": "Python",
    "source": "https://python.org", // inferred from identifier when empty
    "identifier": "RRID:SCR_008394",
    "newReuse": "reuse",
    "additionalInformation": ""      // ALWAYS blank — detector context is never persisted
  },
  "mergedFrom": [                    // provenance copied from the Generated KRT's detectedBy
    { "source": "software_detection", "confidence": 0.8, "originalItem": { /* pre-dedup KrtEntry */ } }
  ]
}
```

**`edit`** — propose updating a single cell of an existing row. Only `resourceName`, `source`, and
`identifier` can produce edits (`resourceType` and `newReuse` are part of the dedup key and immutable;
`additionalInformation` is never edited):

```jsonc
{
  "id": "edit:rrid:ab_2201407|Antibody|reuse:identifier",  // "edit:<dedupKey>:<column>"
  "type": "edit",
  "action": "edit",
  "status": "pending",
  "source": "pdf_analysis",
  "title": "Update IDENTIFIER of Anti-TH",
  "description": "IDENTIFIER: \"\" → \"RRID:AB_2201407\"",
  "detail": "…detector context…",   // may be null
  "context": "…detector blurb…",     // UI-only hint
  "confidence": 0.8,
  "existsInKRT": "update",
  "matchedKrtRowId": "a1b2c3d4-...", // the krt_data row this edit targets
  "data": {
    "rowId": "a1b2c3d4-...",         // authoritative target row id
    "column": "identifier",          // camelCase field key
    "columnLabel": "IDENTIFIER",     // uppercase display label
    "oldValue": "",
    "newValue": "RRID:AB_2201407",
    "resourceType": "Antibody",      // full resource context, for display
    "resourceName": "Anti-TH",
    "source": "https://example.com",
    "identifier": "RRID:AB_2201407",
    "newReuse": "reuse",
    "additionalInformation": ""
  },
  "mergedFrom": [ { "source": "identifier_detection", "confidence": 0.8, "originalItem": { /* … */ } } ]
}
```

**`rejected`** — a previously rejected suggestion, rendered from the `rejected_resources` audit table
(see [database.md](./database.md#krt_data)). The audit fields are immutable, so this view stays stable
even if the Generated KRT later changes:

```jsonc
{
  "id": "add:rrid:scr_008394|Software/code|reuse",
  "type": "add_row",                 // or "edit"
  "status": "rejected",
  "source": "pdf_analysis",
  "title": "Python",
  "description": "Add Software/code: Python",
  "rejectionReason": null,            // user-provided reason, or null
  "rejectedAt": "2026-06-18T10:30:00.000Z",
  "data": { "resourceType": "Software/code", "resourceName": "Python", "identifier": "RRID:SCR_008394", "newReuse": "reuse" }
}
```

### `POST /api/submissions/:id/suggestions/approve`
Approve a suggestion (applies the change to the KRT).
- **Body**: `{ suggestionId }`

### `POST /api/submissions/:id/suggestions/reject`
Reject a suggestion.
- **Body**: `{ suggestionId }`

### `POST /api/submissions/:id/suggestions/regenerate`
Re-run the AI Suggestions (`suggestion_generation`) job — the LM comparison of the author KRT vs the Generated
KRT — and replace the persisted suggestions list. Use after editing the KRT to refresh suggestions (they are not
recomputed on read).

---

## DAS Suggestions

The LM check of the **Data/Code Availability Statement** shown on the `/availability` step (the standalone
`das_suggestions` job). It judges the DAS against the ASAP rulebook and returns a **per-rule verdict**. LM-only:
when disabled / no key (or on failure), the frontend falls back to the legacy in-browser rules. See
[pipeline-modules.md §3.11](./pipeline-modules.md#311-das_suggestions--availability-statement-check-das-suggestions)
for the full rulebook (the 9 checks).

### `GET /api/submissions/:id/das-suggestions`
Get the latest DAS check status + verdicts. Author-accessible (unlike the raw `/jobs` payload).

- **Returns**: `{ status, suggestions, signals, meta }`
  - `status`: the `das_suggestions` job status — `none` (never run) · `queued` · `processing` · `complete` · `failed`.
  - `suggestions`: array of `{ ruleId, severity, title, message, recommendedText, applies, reason, notApplicableReason }`
    (empty when the LM produced nothing → the frontend renders the legacy rules instead). `reason` is the LM's
    per-rule justification, kept for **every** rule (applicable or not) so the UI can show a "More details"
    disclosure on both flagged and passed checks; `notApplicableReason` mirrors it for passed rules (falling back
    to the catalog reason when the LM omitted one).
  - `signals`: the KRT summary booleans handed to the LM as ground truth — `{ has_new_dataset, has_new_code,
    has_dataset_resources, has_code_resources, has_protocol_resources, has_lab_material_resources }` — or `null`
    for pre-existing jobs / the legacy fallback. Surfaced in the view's "What the check saw" panel.
  - `meta`: `{ total, applicable, model, ... }` or `{ skipped: true, reason: 'lm_not_configured' }`.

The `/availability` view shows a **loader** and **blocks Continue** while `status` is `queued`/`processing`.

### `POST /api/submissions/:id/das/confirm`
Confirm that the Availability Statement is the passage the check should read, and
release the check — which does not start on its own.

- **Returns**: `{ dasConfirmedAt, dasConfirmedByUserId, checking }`
- `checking` says whether a run actually started. It is `false` when the check
  already ran on this statement, when it is gated to a later step, and when the
  enqueue failed. The UI uses it to choose its message and whether to poll —
  promising a result that is not coming sends the user to watch a spinner that
  never resolves, with no way to find out why.
- **400** when there is nothing to confirm: an empty statement, or the
  `"Not found"` sentinel extraction writes when it found none. Confirming those
  would send the checker two literal words to review, and bill for it.
- Only needed for a statement that came from automatic **extraction**. Writing
  one by hand records the same thing, in the same person's name — see
  [pipeline-jobs.md](./pipeline-jobs.md#the-availability-statement-and-who-vouches-for-it).
- Releases the step only when it is actually held (`waiting`, `pending_input` or
  `failed`). A check that already ran is not re-run by confirming again, so
  re-opening the confirmation screen cannot turn into a second LM bill.
- No LM rate limiter: confirming spends nothing itself, and rate-limiting a "yes"
  would leave the pipeline parked.

### `POST /api/submissions/:id/das-suggestions/regenerate`
Re-run the DAS check (creates a fresh `das_suggestions` job). Called on first arrival at `/availability` and again
whenever the author edits the DAS text. **Returns**: `{ queued: true, jobId }` (202).
The run is credited to the caller — this is somebody asking for it by name.

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

### `GET /api/submissions/:id/markdown`
The converted manuscript text for the current round. Returns `{ content, fileName, length, version, round }`.
404 when conversion has not produced a file yet.

Served through the API rather than as a presigned S3 link because the Markdown Convert module page *displays*
it: a cross-origin fetch of a presigned URL depends on the bucket's CORS policy, which a view should not be
hostage to. The presigned download still exists via `GET /api/submissions/:id/files/:fileId/download`.

### `POST /api/submissions/:id/markdown/convert`
Re-trigger PDF → Markdown conversion. Cascade-restarts every step that reads the
manuscript, then re-queues conversion through the orchestrator.
- **Returns**: `{ message, status }` — `status` is the step's job status. A
  re-run asked for while a conversion is already in flight is a no-op, and the
  message says so instead of reporting a queued run that will never start.
  The distinction is read **before** re-queueing: `requeueStep` leaves a re-run
  at `queued`, so deciding from the returned row made every re-run report
  "already running", including ones started that instant.

---

## ORCID / Authors

### `GET /api/submissions/:id/authors`
Get extracted authors with ORCIDs.
- **Returns**: `{ authors: [...], meta }`

### `POST /api/submissions/:id/authors/extract`
Trigger ORCID extraction (re-run). Same contract as the conversion re-run above:
goes through the orchestrator, reuses the round's row, and returns
`{ message, status }`.

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
Get the status of every pipeline step for a submission.
- **Returns**: `{ round, inputs, jobs: [...] }` — each job includes `logs`, `files`, `result`, `config`
- `issues` is everything about this round needing a person: `{ jobType, kind
  ('failure' | 'unusable' | 'partial'), blocking, holding, wouldSkip,
  producedOutput, detail, decided }`. Computed server-side so the five surfaces
  that render it cannot disagree.
- Each job carries `blockedBy` — the failed steps holding it, by name — and
  `waitingReason: 'blocked_by_failure'`, which takes precedence over a gate: a
  step behind a failed conversion is also behind `markdown_ready`, and naming the
  gate would be true but useless.
- `inputs` is what the round is being **processed from**: one entry per frozen
  input (`pdf`, `markdown`, `krt`), each with the version the run read, what is
  live now, and `stale`. The pipeline page turns a stale entry into *"This
  analysis used an earlier version of your data"*, naming the document and both
  versions. For the KRT the comparison is row COUNTS, which cannot see an edited
  cell — `stale` means rows were added or removed, never "nothing has changed".
  See [pipeline-jobs.md](./pipeline-jobs.md#one-round-one-pdf-one-krt).
- Non-fatal: if the freeze state cannot be computed, `inputs` is `[]` and the
  page simply says nothing about provenance rather than failing to load.
- A `waiting` job that is held by a submission-state gate (datasets/materials/protocols before KRT validation)
  carries `waitingReason: 'krt_validation'`, so the UI can show *"Waiting for the Key Resources Table to be
  validated."* These advance automatically once the KRT is validated — no `advance` call is needed (that is only
  for `pending_input` jobs).

### `POST /api/submissions/:id/processes/run`
Run (or re-run) the whole pipeline for a submission. Every step in the
round is about to run, so **every input freeze is released** — this is the call a
PDF upload makes, and it is what lets a replaced manuscript reach the pipeline.

### `POST /api/submissions/:id/processes/restart`
Re-run a **chosen set** of steps as one restart.

- **Body**: `{ jobTypes: string[], paramsSource?: 'live' | 'frozen' }` — step
  names, at most 20.
- **Returns**: `{ message, restarted, reset, paramsSource }`. `reset` is what
  the selection carried with it (its shared downstream) — the UI already showed
  the user, but a script or a log has to be told.
- **`paramsSource`** decides which prompts and model the re-run uses. `live`
  (the default) is today's; `frozen` is what each step's previous execution
  recorded. A restart already re-reads the round's frozen INPUTS, so without
  this a re-run that disagrees with the original cannot be told apart from a
  prompt somebody edited in between. Default is `live` because the common
  restart is "I changed the prompt, run it again".
- **400** on an unknown or empty list, *before anything is touched*: half a
  restart is worse than none, because the caller has to work out which half ran.
- **Not a loop of single restarts.** The first step to finish would release the
  work the selection shares — grounding, the consolidator — which then runs and
  is thrown away by the next reset, and both runs are paid for. Every selected
  step's downstream is reset before any of them is enqueued.
- Behind the LM budget: a selection of five detectors is five detectors' worth of
  model work.

### `GET /api/submissions/:id/runs?round=N`
Every **pipeline run** of the round, and what each one contains.

- **Returns**: `{ round, runCount, runs: [{ runNumber, cause, status,
  paramsSource, causedBy, createdAt, completedAt, pipelineVersion, appVersion,
  steps: [{ jobType, carriedOver, status, outcomeState, counts, durationMs }] }] }`
- The submission-wide view: "run 2" as ONE number across every module, rather
  than a different number per module shown in the same place. Not derivable from
  the per-step endpoints — those say what happened to a step across runs, and
  cannot say what a run did.
- Same audience as the other job internals: an author reads the latest result.

### `GET /api/submissions/:id/jobs/:jobType/runs?round=N`
Every pipeline run **containing this step**, newest first, metadata only.

- **Returns**: `{ round, jobType, runCount, runs: [...] }`, each entry carrying
  `runNumber`, `isLatest`, `cause`, `carriedOver`, `producedByRun`, `status`,
  `outcomeState`, `counts`, `attemptCount`, `cancelledAt`, `discardedCount`,
  `triggeredBy`, `triggerKind` and the timings.
- A step the run **carried over** appears, flagged, naming the run that did the
  work. Under the old per-step numbering it simply was not in the list, so
  comparing run 2 with run 3 made the step look like it had vanished.
- A step the run has **not reached** appears as `not_started` rather than being
  hidden, which would make the current run look shorter than it is.

### `GET /api/submissions/:id/jobs/:jobType/runs/:runNumber?round=N`
One run of one step, in full — shaped like a job, so a past run renders through
exactly the same path as the current one.

- Adds `result`, `logs`, `files`, `inputs`, `documents`, `attempts`,
  `cancelledAt`, `cancelledBy`, `discarded` and `artefactsAreOwn`.
- **Not a 404** when the run contains the step but has not executed it: the run
  is real and the answer is "nothing yet", which a spinner cannot say.

### `POST /api/submissions/:id/jobs/:jobType/continue?round=N`
Proceed despite a step's **issue** — a failure, a partial, or a run that
completed while producing nothing usable.

- **Returns**: `{ message, jobType, acknowledgedAt }`
- Re-runs nothing and does not mark the step successful — it stays `failed`.
  What is recorded is `step_executions.decision` — `{ at, byUserId, choice }` on
  the EXECUTION it was made about, not on the step: a report built without
  software detection looks exactly like one where software detection found
  nothing, and only this tells them apart.
- **400** unless the step actually has an issue. Deciding twice is *not* an
  error, and the second caller does not overwrite the first's name.
- What it releases depends on what the step produced: dependants that can run on
  less do; dependants that REQUIRED its output are marked `skipped`, recording
  what was missing.
- No LM limiter: it starts nothing itself, it releases steps that were already
  going to run.

### `POST /api/submissions/:id/jobs/:jobType/retry?round=N`
Run a **failed** step again, and change nothing else.

- **Returns**: `{ message, jobType, status }`
- **400** unless the step failed **and nothing downstream has run since**. The
  message names the step that already ran and points at the restart that would
  work — "cannot retry" with no way forward is a dead end.
- Deliberately does **not** release the round's input freezes, cascade, or run
  `onManualRestart`. Each of those would make it a restart wearing a smaller
  name; in particular a retry of DAS extraction must not clear a statement the
  author typed while the service was down.
- `retryCount` is reset with the row — those attempts belonged to the run that
  failed.

### `POST /api/submissions/:id/jobs/:jobType/advance?round=N`
Manually advance a `pending_input` job to `queued`.

### `GET /api/submissions/:id/jobs/:jobType/responses/:responseName?round=N`
Get a presigned S3 download URL for a job's raw API response file.
- **Returns**: `{ url, name, s3Key, round }`

---

## Configuration (Public)

### `GET /api/submissions/:id/jobs/:jobType/prompts`
The prompt(s) a run used, read back from its own frozen inputs. Scoped by
`canAccessSubmission` — whoever may open the submission may read them.
- **Returns**: `{ prompts: [{ key, file, text, sha256, bytes, attachments: [{ file, text, sha256, bytes }] }] }`
- Served from the run's **stored copy** — never from the file on disk, and never
  as a link to GitHub: a deployment is not always at the head of its branch, so
  a link can show a prompt that is not the one that ran.
- Not folded into `GET /jobs`: that payload is polled every few seconds, and a
  template per module would add tens of kilobytes to every poll for something
  read only when the Technical detail panel is opened.
- A run with no stored inputs returns `{ prompts: [], reason: 'no_inputs_artefact' }`
  rather than a 404 — a skipped or fallback run legitimately has none.

### `GET /api/config/krt-template`
Get the KRT template URL. Returns `{ url }`.

### `GET /api/config/resource-types`
Get valid resource type names from the DB-backed catalog.

### `GET /api/config/environment`
Get the current environment label and signup flag. Returns `{ environment, signupEnabled }`.

### `GET /api/config/services`
Get the runtime state of every background service. Returns `{ services: { das_extraction, pdf_analysis, suggestion_generation, software_detection, orcid_extraction, markdown_convert, datasets_detection, materials_detection, protocols_detection, identifier_detection } }` — each entry is `{ state: 'on' | 'demo' | 'off', enabled: boolean, hasDemoData: boolean }`. The ORCID entry also exposes `subServices.{grobid, openalex, orcid_api}`.

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
