# Roles and Permissions

This document is the source of truth for what each role can see and do in
asap-kr-sync. Update this file whenever a new gated feature is added.

## Roles

| Role | Intent |
|---|---|
| `author` | Manuscript author. Sees only their own submissions. Minimal UI: only what they need to do their job. |
| `asap_pm` | ASAP Project Manager. "Super author" scoped to their team(s). Same edit rights as an author, applied to every submission in their team(s). Cannot delete. |
| `ds_annotator` | Data Science annotator. Non-technical staff. Sees all submissions and most features, but technical/debug surfaces are intentionally simplified. |
| `admin` | Full access. Can do everything, including admin-only operations (delete users, force-delete teams, manage validation rules). |

`ds_annotator` and `admin` are currently treated as equivalent for permission
purposes — the only difference is in *technical data display* (raw logs, raw
job responses) which both still see today, until a stronger separation is
needed.

## Teams, projects & submission visibility

A **team** is a lab, identified by its leader's name (e.g. "Alessi", "Wood").
Users belong to one or more teams (`user_teams`). A **project** is the 2-letter
grant code (WH, CS, …) extracted from the manuscript ID and stored on
`submissions.project`; it is a **filter/label only** and does **not** affect who
can see a submission.

Visibility is derived from the submission's **owner's teams**
(`middleware/team.middleware.js`):

- **author** — only their own submissions.
- **asap_pm** — their own, plus any submission whose **owner shares one of the
  PM's teams**. (Two teams working the same project each see only their own
  team's submissions, because ownership — not the project — drives visibility.)
- **ds_annotator / admin** — all submissions.
- **Staff-owned submissions are hidden from non-staff.** admins/ds_annotators
  upload many PDFs for testing, so their own submissions never surface for
  authors or PMs. Staff hand a document to the real user via **reassign owner**
  (`PATCH /api/submissions/:id/owner`, admin/ds_annotator only), after which it
  follows the new owner's teams.

Team membership can be auto-assigned from an admin-managed email→team roster
(`team_emails`, the **Team Email Assignment** page) applied on sign-in.

## Permission matrix

| Capability | author | asap_pm | ds_annotator | admin |
|---|---|---|---|---|
| View own submissions | ✓ | ✓ | ✓ | ✓ |
| View teammates' submissions (owner shares a team) | — | ✓ | ✓ | ✓ |
| View all submissions | — | — | ✓ | ✓ |
| Create submission | ✓ | ✓ | ✓ | ✓ |
| Edit submission (metadata, KRT, PDF, suggestions) | own | teammates' | all | all |
| Reassign submission owner | — | — | ✓ | ✓ |
| View / edit KRT QC & Optional flags | — | — | ✓ | ✓ |
| Hide / unhide submission | own | teammates' | all | all |
| Delete submission (hard delete) | — | — | ✓ | ✓ |
| Trigger AI analysis | own | teammates' | all | all |
| View job summary status (panel) | ✓ | ✓ | ✓ | ✓ |
| View job internals (logs, raw responses, timestamps, queue config) | — | ✓ | ✓ | ✓ |
| Restart / advance / retry jobs | — | — | ✓ | ✓ |
| View users (scoped) | — | team | all | all |
| Create non-admin users | — | — | ✓ | ✓ |
| Edit non-admin users | — | — | ✓ | ✓ |
| Create / edit admin users | — | — | — | ✓ |
| Delete users | — | — | — | ✓ |
| List / create / edit teams (lab, by leader name) | — | — | ✓ | ✓ |
| Delete teams (no users/submissions attached) | — | — | ✓ | ✓ |
| Force-delete teams (with submissions attached) | — | — | — | ✓ |
| Manage projects (grant codes) + CSV import/export | — | — | ✓ | ✓ |
| Manage team-email roster (Team Email Assignment) + CSV import/export | — | ✓ | ✓ | ✓ |
| Manage resource types | — | — | ✓ | ✓ |
| Manage enrichment lists (software/datasets/materials/protocols) | — | — | ✓ | ✓ |
| Manage validation rules | — | — | — | ✓ |

## Where each rule is enforced

### Backend

- **Submission scoping** — `src/backend/middleware/team.middleware.js`
  - `canAccessSubmission` validates per-record access — author: own; asap_pm:
    own or a submission whose owner shares one of the PM's teams (staff-owned
    excluded); ds_annotator/admin: all.
  - `attachSubmissionFilter` builds the SQL `WHERE` clause for list endpoints
    (owner ∈ {self, teammates}, minus staff-owned for non-staff).
- **Coarse role gates** — `src/backend/middleware/role.middleware.js`
  - `requireRole(...roles)`, `requireAdmin`, `canCreateSubmission`.
- **Feature-specific gates** — `src/backend/middleware/feature-access.middleware.js`
  - `canViewJobInternals` — blocks authors from `/jobs/:jobType/responses/...`.
  - `canManageJobs` — restricts `/jobs/:jobType/advance` to staff.
- **Controller-level guards**
  - `src/backend/controllers/users.controller.js` — `assertCanTouchAdminRole` blocks ds_annotator from creating, editing, or promoting admin users.
  - `src/backend/controllers/teams.controller.js` — `deleteTeam` refuses team deletion when submissions are attached unless the actor is admin.
  - `src/backend/controllers/jobs.controller.js` — `getJobs` strips `logs`, `result.files`, and `config` from the JSON response when the requester is an author.
  - The KRT row update endpoint role-gates the `is_qc` / `is_optional` columns — only admin and ds_annotator may set them (regular users never see or edit the QC/Optional flags).

### Frontend

- **Auth store** — `src/frontend/src/stores/auth.store.js` exposes computed
  flags that mirror the backend rules. UI components consume these instead of
  hardcoding role strings.
  - Submission: `canDeleteSubmission`, `canHideSubmission`, `canEditSubmission(submission)`.
  - Jobs: `canViewJobInternals`, `canManageJobs`.
  - Users: `canEditAnyUser`, `canEditAdminUsers`, `canDeleteUsers`.
  - Teams/projects: `canManageTeams`, `canManageTeamEmails` (admin/ds/pm). Owner
    reassignment lives in `EditMetadataModal.vue`, gated on `isStaff`.
  - Reference data: `canManageResourceTypes`, `canManageEnrichments`, `canManageValidationRules`.
  - Aggregates: `isAdmin`, `isStaff`.
- **Router guards** — `src/frontend/src/router/index.js` uses `meta.roles` per
  route, evaluated against `effectiveRole` (so admin "view-as" works).
- **Components** — see `AppSidebar.vue` (nav links), `SubmissionCard.vue`
  (per-row actions), `DashboardView.vue` (bulk actions), `JobStatusPanel.vue`
  (modal sections).

## Admin "View as" mode

Admins can simulate any role from `AppHeader.vue` to verify the UI behavior of
other roles. This affects `effectiveRole` only — the backend always validates
against the real role on `req.user.role`. So a viewing admin cannot escalate
or de-escalate access via API calls; the simulation is purely cosmetic.

## Adding a new gated feature

1. Decide which roles should have access.
2. Add the backend gate (route middleware and/or controller guard).
3. Add a matching computed property in `auth.store.js` (don't hardcode role
   strings in components — go through the store).
4. Use the computed in the relevant `v-if`.
5. Update the matrix in this file.
