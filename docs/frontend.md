# Frontend

The frontend is a Vue 3 Single-Page Application using the Composition API, Pinia for state management, and Tailwind CSS for styling.

## Technology Stack

| Library | Version | Purpose |
|---------|---------|---------|
| Vue | ^3.4 | UI framework (Composition API, `<script setup>`) |
| Vite | ^8.0 | Build tool and dev server |
| Pinia | ^2.1 | State management |
| Vue Router | ^4.2 | Client-side routing |
| Axios | ^1.15 | HTTP client (`withCredentials: true` for cookie auth) |
| Tailwind CSS | ^3.4 | Utility-first CSS framework |
| Headless UI | ^1.7 | Accessible unstyled UI components |
| Heroicons | ^2.1 | SVG icons |
| VueUse | ^10.7 | Composition API utilities |
| Papa Parse | ^5.5 | CSV parsing in the enrichment-list import flow |
| Vitest | ^4.1 | Test runner |

The KRT table editor (`KRTEditor.vue`) is a custom component — not AG Grid. Form validation is done with plain refs and bespoke helpers; there is no schema-validation library wired up.

## Project Structure

```
src/frontend/src/
├── assets/             Static assets and global styles
│   └── styles/
│       ├── main.css    Tailwind directives + custom component classes
│       ├── badges.css  The `rbadge-*` result-table palette (one place)
│       └── module-tables.css  The `.mtable` / `.mt-row-*` block row layout
├── components/
│   ├── common/         Generic UI (NotificationContainer)
│   ├── krt/            KRT editor (KRTEditor, KRTCellEditModal)
│   ├── layout/         App shell (AppLayout, AppHeader, AppSidebar)
│   ├── modules/        Module results pages: tables, viewers, shared row models
│   └── submission/     Submission workflow components
├── composables/        Reusable stateful logic
├── router/             Route definitions and guards
├── services/           API client layer (Axios wrappers)
├── stores/             Pinia state management
└── views/              Page-level components
    ├── admin/          Admin pages
    ├── auth/           Login, register
    ├── dashboard/      Submission list
    ├── profile/        User profile
    └── submissions/    Submission workflow steps
```

## Routing

All routes are defined in `src/frontend/src/router/index.js` with lazy-loaded components.

### Public Routes

| Path | View | Notes |
|------|------|-------|
| `/login` | LoginView | `requiresGuest` — redirects to dashboard if authenticated |
| `/register` | RegisterView | `requiresGuest` |

### Protected Routes (require authentication)

All wrapped in `AppLayout` (header + sidebar).

| Path | View | Step |
|------|------|------|
| `/dashboard` | DashboardView | — |
| `/submissions/create` | CreateSubmissionView | — |
| `/submissions/:id` | SubmissionDetailView | — |
| `/submissions/:id/krt` | KRTView | Step 1: KRT Upload & Validation |
| `/submissions/:id/pdf` | PDFView | Step 2: PDF Upload & Analysis |
| `/submissions/:id/review` | ReviewView | Step 3: Review Suggestions |
| `/submissions/:id/availability` | AvailabilityView | Step 4: Data Availability |
| `/submissions/:id/report` | ReportView | Step 5: Report Generation |
| `/submissions/:id/pipeline` | PipelineView | The run as a graph — every step, its stage, what it consumed |
| `/submissions/:id/module/:type` | ModuleResultsView | One module's results, in full |
| `/profile` | ProfileView | — |

`das_suggestions` is a pipeline step gated to the Availability step. It has a
page and appears on the pipeline page like any other module; the panel on the
KRT and PDF steps does not show it, since those are not where it runs.

The rule that makes this safe is in `useJobPoller`: a step **waiting behind a
stage the submission has not reached** is not outstanding work for the step the
user is on, and is excluded from `isAnyRunning` and from `PDFView`'s
`allProcessesFinished`. The server names the reason (`waitingReason:
'availability_step'`) so the distinction is made where it is known rather than
guessed from the job type — `isFutureStepJob` is the single place that decides.
Widening it to any waiting job would exempt a detector held by the KRT gate,
which is work the user can release right now.

Both pipeline routes set `meta.remountOnRouteChange`. `AppLayout` keys its
`<RouterView>` on the full path for those routes, because the same component
instance is reused when only a route PARAM changes — so `onMounted` does not
re-fire and moving from one module (or submission) to another would leave the
previous one's data on screen under the new URL.

### Admin Routes (role-restricted)

| Path | View | Allowed Roles |
|------|------|---------------|
| `/admin/users` | UsersView | admin, ds_annotator, asap_pm |
| `/admin/teams` | TeamsView | admin, ds_annotator |
| `/admin/team-emails` | TeamEmailsView | admin, ds_annotator, asap_pm |
| `/admin/projects` | ProjectsView | admin, ds_annotator |
| `/admin/krt-editor/resource-types` | ResourceTypesView | admin, ds_annotator |
| `/admin/krt-editor/validation-rules` | AppConfigView | admin |
| `/admin/enrichments` | EnrichmentListView | admin, ds_annotator |

`TeamEmailsView` manages the email→team roster (auto team assignment) and
`ProjectsView` manages the 2-letter grant codes; `TeamsView`, `ProjectsView` and
`TeamEmailsView` all offer CSV import/export.
Data-table admin pages carry an in-table search box (client-side post-filter of
the current page) and fill the remaining viewport height with an inner scroll.

The four curated lists (software, materials, datasets, protocols) are all managed by the single `EnrichmentListView`, with category tabs in the UI and a `?category=…` filter applied to the underlying `/api/enrichment-list` endpoint.

### Route Guards

The `beforeEach` navigation guard handles:

1. **Auth0 callback** — extracts tokens from URL hash after OAuth redirect
2. **Token restoration** — fetches current user if token exists in localStorage
3. **Auth enforcement** — redirects unauthenticated users to `/login`
4. **Role check** — redirects users without required role to `/dashboard`
5. **Guest check** — redirects authenticated users away from login/register

The `afterEach` guard updates the page title dynamically.

## State Management (Pinia Stores)

### Auth Store (`auth.store.js`)

Manages authentication state and role-based permissions. Tokens are **not** in the store — they live in HttpOnly cookies set by the backend (Phase 6). The store only ever sees the `user` object returned by `GET /api/auth/me`.

**Key state:** `user`, `loading`, `error`, `viewAsRole` (admin role simulator).

**Key computed:** `isAuthenticated`, `userRole`, `userTeams`, `isRealAdmin`, `effectiveRole` (respects `viewAsRole`), `isAuth0User`, `isAdmin`, `isStaff`, plus a family of capability flags that mirror the backend rules: `canCreateSubmission`, `canDeleteSubmission`, `canHideSubmission`, `canEditSubmission(submission)`, `canAccessSubmission(submission)`, `canManageUsers`, `canViewUsers`, `canManageTeams`, `canManageTeamEmails`, `canEditAnyUser`, `canEditAdminUsers`, `canDeleteUsers`, `canManageResourceTypes`, `canManageEnrichments`, `canManageValidationRules`, `canViewJobInternals`, `canManageJobs`.

**Key actions:** `login(email, password)`, `auth0PasswordLogin(email, password)`, `register(...)`, `logout()` (redirects to `auth0LogoutUrl` when present), `fetchCurrentUser()`, `refreshAccessToken()`, `setAuth(user) / clearAuth()`, `setViewAsRole(role) / clearViewAsRole()`, `initialize()`.

### Submission Store (`submission.store.js`)

Manages submission CRUD, filtering, pagination, and file tracking.

**Key state:** `submissions`, `hiddenSubmissions`, `currentSubmission`, `latestFiles`, `pagination`

**Key actions:** `fetchSubmissions(params)`, `fetchSubmission(id)`, `createSubmission()`, `updateSubmission()`, `deleteSubmission()`, `processNewVersion()`, `hideSubmission()`, `unhideSubmission()`

### KRT Store (`krt.store.js`)

Manages KRT table data, cell editing, validation, and AI suggestions.

**Key state:** `rows`, `validationErrors`, `aiSuggestions`, `editingCell`, `summary`

**Key computed:** `getRowErrors(rowId)`, `getRowSuggestions(rowId)`, `getCellSuggestion(rowId, column)`, `addRowSuggestions`, `deleteRowSuggestions`

**Key actions:** `fetchKRT()`, `uploadKRT()`, `updateCell()`, `batchUpdateCells()`, `addRow()`, `deleteRow()`, `mergeRows()`, `validate()`, `fetchAiSuggestions()`, `updateSuggestionStatus()`, `regenerateSuggestions()`

**Change sources:** `manual`, `ai_suggestion`, `krt_validation`

### Notification Store (`notification.store.js`)

Toast notification system with auto-dismiss.

**Actions:** `success()`, `error()`, `warning()`, `info()`, `remove()`, `clear()`

### Other Stores

- **Teams Store** (`teams.store.js`) — team CRUD with `activeTeams` computed; CSV `exportTeams`/`importTeams`; team-email roster list/create/delete/export
- **Projects Store** (`projects.store.js`) — project (grant code) CRUD plus CSV `exportProjects`/`importProjects`
- **Resource Types Store** (`resourceTypes.store.js`) — resource type CRUD
- **App Config Store** (`appConfig.store.js`) — runtime configuration management

## Composables

### `useJobPoller`

Polls background job status with exponential backoff (3s → 30s max, 1.5× factor, 20 min timeout). Fires callbacks on status transitions: `onJobComplete`, `onJobFailed`, `onJobPendingInput`. See [Background Jobs](./background-jobs.md).

### `useAsyncAction`

Wraps async operations with loading state and automatic notifications.

```javascript
const { loading, execute } = useAsyncAction()
await execute(() => api.doSomething(), {
  successMessage: 'Done!',
  errorMessage: 'Failed'
})
```

### `useJobPoller`

Polls `/api/submissions/:id/jobs` while anything is running, backing off from
2s towards 30s and stopping at 20 minutes or when nothing is left in flight.
Exposes the job list, per-type lookups, and `onJobComplete(type, fn)` hooks.

### `useColumnResize`

Drag-to-resize table columns, persisted per table key in localStorage. Window
listeners are released on scope dispose, so a component unmounting mid-drag
does not leak them.

## Service Layer

All API calls go through service modules in `src/frontend/src/services/`. Each service wraps Axios calls to the backend.

### API Client (`api.js`)

- Base URL: `/api`
- Timeout: 30 seconds (some upload services override to 2 min)
- `withCredentials: true` so the session cookie travels on every request
- Request interceptor: reads the `asap_kr_csrf` cookie and echoes it in the `X-CSRF-Token` header on every state-changing request (POST/PATCH/PUT/DELETE)
- Response interceptor: on 401 (for any non-auth endpoint), de-dupes a single `POST /auth/refresh` call across concurrent failures, then retries the original request. If the refresh itself 401s, clears the store and redirects to `/login`.

### Services

| Service | Key Methods |
|---------|------------|
| `auth.service.js` | `login`, `register`, `logout`, `refreshToken`, `getCurrentUser`, `auth0PasswordLogin` |
| `submission.service.js` | `list`, `getById`, `create`, `update`, `delete`, `getChanges`, `hide`, `unhide`, `listHidden`, `getFilterOptions`, `uploadSupplemental`, `processNewVersion` |
| `krt.service.js` | `getData`, `upload` (2 min timeout), `updateRow`, `addRow`, `deleteRow`, `mergeRows`, `validate`, `download` |
| `pdf.service.js` | `upload` (2 min timeout), `getAnalysisStatus`, `getFindings`, `triggerAnalysis`, `extractDAS` |
| `markdown.service.js` | `triggerConvert` |
| `job.service.js` | `getJobs`, `runAllProcesses`, `advanceJob`, `getJobResponseUrl` |
| `suggestion.service.js` | `getSuggestions`, `approveSuggestion`, `rejectSuggestion`, `regenerateSuggestions` |
| `orcid.service.js` | `getAuthors`, `triggerExtraction` |
| `datasets.service.js` | `getMentions`, `triggerDetection` |
| `software.service.js` | `getMentions`, `triggerDetection` |
| `materials.service.js` | `getMentions`, `triggerDetection` |
| `protocols.service.js` | `getMentions`, `triggerDetection` |
| `identifier-detection.service.js` | `getMentions`, `triggerDetection` |
| `report.service.js` | `generate`, `list`, `getById`, `download` |
| `file.service.js` | `download` |
| `enrichment-list.service.js` | Single service backing every category — list (cross- or per-category), `getCounts`, `getById`, `create`, `update`, `remove`, `importEntries`, `exportCsv` |
| `teams.service.js` | `list`, `getCodes`, `create`, `update`, `delete`, `exportCsv`, `importCsv`, plus email-mappings `listEmailMappings`, `createEmailMappings`, `deleteEmailMapping`, `exportEmailMappings` |
| `projects.service.js` | `list`, `getCodes`, `create`, `update`, `delete`, `exportCsv`, `importCsv` |
| `resourceTypes.service.js` | `list`, `getNames`, `create`, `update`, `delete`, `exportCsv`, `importEntries` |
| `appConfig.service.js` | `list`, `get`, `save`, `delete` |
| `config.service.js` | `getServiceStatus`, `getEnvironment` |
| `demos.service.js` | `list` |
| `profile.service.js` | `get`, `update` |

A handful of admin views (notably `UsersView.vue`) call the `api` instance directly without a dedicated service file.

## Key Components

### Layout

- **AppLayout** — main authenticated layout with header and collapsible sidebar
- **AppHeader** — top navigation with user menu and environment badge
- **AppSidebar** — left navigation with workflow steps and admin links

### KRT Editor

- **KRTEditor** — main table editor with inline cell editing, validation error display, and AI suggestion indicators. Also provides:
  - **QC / Optional flags** — boolean per-row flags, shown and editable **only** for Administrator and DS Annotator roles (regular users never see them).
  - **Merge rows** — select ≥2 rows, then a modal to pick each column's value, committing a transactional bulk-delete + create one merged row (`POST /api/submissions/:id/krt/merge`).
  - **Inline shortcut dropdowns** — quick-pick dropdowns for Resource Type and New/Reuse directly in each row.
  - **One-click bulk fixes** — resource-type validation errors carrying a `suggestedValue` are grouped into bulk fixes (e.g. "Set 4 → Software/code").
  - **Resizable columns** — drag a header edge to resize; the width is remembered per browser.
  - **Filter tabs / row order / search / column sorting** — tabs filter by resource-type group; a separate segmented control switches row order between *As submitted* and *By resource type*.
  - **Quick actions on empty cells** — one-click `No identifier exists` / `Identifier pending` for IDENTIFIER, `None` for SOURCE.
  - **Suggestion review** — accept, reject-with-reason, or **edit a suggested row's values before accepting** (only changed fields are sent). Badges: `In KRT`, `Update`, `Verify` (tier `needs_verification`), plus contributing detection modules from `mergedFrom`.
  - **Bulk operations** — select-all-visible, then Approve selected (confirm modal at ≥5), Approve with Resource Type…, Reject selected, Edit column…, Merge…, Delete selected.
  - **Jump-to navigation** — the error / warning / suggestion counters scroll to the first occurrence.
- **KRTCellEditModal** — modal for editing cells with longer content

> `KRTEditor` serves **Steps 1 and 2** only. Step 3 (`ReviewView`) renders its own review-only diff
> table. Full feature reference: [KRT Editor](./krt-editor.md).

### Submission Workflow

- **StepIndicator** — visual 5-step progress indicator
- **StepHelpPanel** — contextual help text for each workflow step
- **SubmissionHeader** — submission metadata display with edit/action buttons
- **JobStatusPanel** — one tile per pipeline step, with its configuration (On / Demo / Off), status and result
  summary. A tile whose job is **complete is a link** to that module's page, so ctrl-click and middle-click open it
  in a tab like any other link. A tile whose job is not complete opens a small modal carrying what such a job
  actually has: status, notice bar, process logs, raw responses and any error. A step held because the manuscript
  produced no text says so in place of the remaining-time estimate — an estimate would be a lie, since nothing is
  going to finish. (There was an equivalent banner for the KRT gate telling the user to click Continue; it went
  when the panel left the KRT step, which was the only place it could be acted on.)
- **BackgroundProcesses** — the panel's wrapper: overall progress, the "view pipeline" link, and the message shown
  when every runnable module has finished and the rest are held at a gate. **Rendered on the PDF step only.**

  It was on the KRT step too. Both files are uploaded when the submission is created, so the pipeline is already
  running while the author works on their table: conversion, ORCID and DAS extraction go, and the detectors sit
  waiting on `krt_curated` because their prompts are seeded with the author's rows. Showing that there put a row of
  modules "waiting for the Key Resources Table to be validated" in front of someone in the middle of validating it
  — a status they can neither act on nor ignore, about work they do not need to think about.

  KRTView still USES the poller — the curator edits their table while analysis runs, and the suggestions and the
  extracted statement should appear without a refresh. Only the display was removed.
- **SubmissionHeader** — the identity strip present on every submission page, and therefore where the link to the
  pipeline lives now that the statuses are on one step. Title · edit · **Pipeline** on the first line; manuscript
  id · KRT · PDF · all-files on the second.
- **EditMetadataModal** — edit submission title and DAS
- **NewRoundModal** — start a new submission round (revision)

### Module Results (`components/modules/`)

Every pipeline step has a page at `/submissions/:id/module/:type`; there is no
longer a second copy of any results table inside a modal. The pages share:

| Piece | What it is |
|-------|-----------|
| `module-meta.js` | Every module — label, one-line purpose, stage names. `ALL_JOB_TYPES`, `MODULE_PAGE_TYPES` and `hasModulePage()` all derive from it. `JobStatusPanel` keeps its own ordered tile list: its three-row grouping is deliberate and differs from the order here, and it omits the DAS check because the panel appears on steps where that one does not run. |
| `module-explainers.js` | The longer "what this step does / how to read it" text, plus the doc anchor each links to. |
| `ModuleExplainer.vue` | Renders that text above the results. |
| `ModuleTechnical.vue` | The Technical detail block: configuration, statistics, module inputs and module outputs, on a six-column grid. Reads `result.data.meta` — one path, because every module stores it there ([the contract](./background-jobs.md#result-summaries)); a reader tolerant of two shapes lets the next module drift, and the drift shows up as a blank column rather than an error. `READS` names what each module consumes, so a module missing from it renders an empty inputs column. |
| `SubmissionFileLinks.vue` | The PDF and KRT links in the top-right of every module page. |
| `DetectionsTable.vue` | The five detectors' output: one row per detection, evidence quoted with its section, enrichment-filled cells marked. |
| `GeneratedKrtTable.vue` + `generated-krt.js` | The consolidated KRT. The row model flattens each merged item into its contributors and marks group boundaries so a merge reads as one block. |
| `GroundingTable.vue` | Per-author-row verdicts: confirmed / incomplete / not detected, with what matched and where. |
| `SuggestionsTable.vue` + `suggestion-decisions.js` | The full decision log, author row against proposed row. |
| `DasSuggestionsTable.vue` + `das-suggestions.js` | The Availability Statement check, rule by rule — including the rules that PASSED, so a clean statement is distinguishable from an unchecked one. Rules needing action expand to the explanation and, where the rulebook has one, the wording to paste. |
| `AuthorsTable.vue` | ORCID extraction, with the ladder that found each id (GROBID, OpenAlex, ORCID API). |
| `MarkdownViewer.vue` + `markdown-render.js` | The converted manuscript, raw or rendered. The renderer escapes first and allowlists `http(s)` links only — its output goes to `v-html`, and its input is a conversion of an uploaded file. |

Two shared stylesheets keep these consistent, and are the place to change any
of it: `assets/styles/badges.css` (the `rbadge-*` palette — category colours
taken from `/admin/krt-editor/resource-types`, amber and red reserved for
status) and `assets/styles/module-tables.css` (`.mtable` plus the `.mt-row-*`
classes that draw an item as a block, whether it occupies one row or two).

## Build Configuration

Vite config (`vite.config.js`):

- **Dev server:** port 5173, proxies `/api` to `VITE_API_URL` or `http://localhost:3000`
- **Path alias:** `@` → `./src`
- **Source maps:** enabled in dev/staging, disabled in production
- **Environment:** exposes `__APP_VERSION__` from package.json

## Styling

Tailwind CSS with custom configuration:

- Custom primary color palette (blue-based, shades 50–950)
- Custom component classes defined in `main.css` (`btn`, `input`, `card`, `badge`, etc.)
- AG Grid uses the Alpine theme with custom color overrides
