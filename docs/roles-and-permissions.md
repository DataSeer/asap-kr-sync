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

## Permission matrix

| Capability | author | asap_pm | ds_annotator | admin |
|---|---|---|---|---|
| View own submissions | ✓ | ✓ | ✓ | ✓ |
| View team submissions | — | ✓ | ✓ | ✓ |
| View all submissions | — | — | ✓ | ✓ |
| Create submission | ✓ | ✓ | ✓ | ✓ |
| Edit submission (metadata, KRT, PDF, suggestions) | own | team | all | all |
| Hide / unhide submission | own | team | all | all |
| Delete submission (hard delete) | — | — | ✓ | ✓ |
| Trigger AI analysis | own | team | all | all |
| View job summary status (panel) | ✓ | ✓ | ✓ | ✓ |
| View job internals (logs, raw responses, timestamps, queue config) | — | ✓ | ✓ | ✓ |
| Restart / advance / retry jobs | — | — | ✓ | ✓ |
| View users (scoped) | — | team | all | all |
| Create non-admin users | — | — | ✓ | ✓ |
| Edit non-admin users | — | — | ✓ | ✓ |
| Create / edit admin users | — | — | — | ✓ |
| Delete users | — | — | — | ✓ |
| List teams | — | — | ✓ | ✓ |
| Create / edit teams | — | — | ✓ | ✓ |
| Delete teams (no submissions attached) | — | — | ✓ | ✓ |
| Force-delete teams (with submissions attached) | — | — | — | ✓ |
| Manage resource types | — | — | ✓ | ✓ |
| Manage enrichment lists (software/datasets/materials/protocols) | — | — | ✓ | ✓ |
| Manage validation rules | — | — | — | ✓ |

## Where each rule is enforced

### Backend

- **Submission scoping** — `src/backend/middleware/team.middleware.js`
  - `canAccessSubmission` validates per-record access (owner / team / staff).
  - `attachSubmissionFilter` builds the SQL `WHERE` clause for list endpoints.
- **Coarse role gates** — `src/backend/middleware/role.middleware.js`
  - `requireRole(...roles)`, `requireAdmin`, `canCreateSubmission`.
- **Feature-specific gates** — `src/backend/middleware/feature-access.middleware.js`
  - `canViewJobInternals` — blocks authors from `/jobs/:jobType/responses/...`.
  - `canManageJobs` — restricts `/jobs/:jobType/advance` to staff.
- **Controller-level guards**
  - `src/backend/controllers/users.controller.js` — `assertCanTouchAdminRole` blocks ds_annotator from creating, editing, or promoting admin users.
  - `src/backend/controllers/teams.controller.js` — `deleteTeam` refuses team deletion when submissions are attached unless the actor is admin.
  - `src/backend/controllers/jobs.controller.js` — `getJobs` strips `logs`, `result.files`, and `config` from the JSON response when the requester is an author.

### Frontend

- **Auth store** — `src/frontend/src/stores/auth.store.js` exposes computed
  flags that mirror the backend rules. UI components consume these instead of
  hardcoding role strings.
  - Submission: `canDeleteSubmission`, `canHideSubmission`, `canEditSubmission(submission)`.
  - Jobs: `canViewJobInternals`, `canManageJobs`.
  - Users: `canEditAnyUser`, `canEditAdminUsers`, `canDeleteUsers`.
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
