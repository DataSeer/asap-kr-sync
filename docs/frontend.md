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
│       └── main.css    Tailwind directives + custom component classes
├── components/
│   ├── common/         Generic UI (NotificationContainer)
│   ├── krt/            KRT editor (KRTEditor, KRTCellEditModal)
│   ├── layout/         App shell (AppLayout, AppHeader, AppSidebar)
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
| `/profile` | ProfileView | — |

### Admin Routes (role-restricted)

| Path | View | Allowed Roles |
|------|------|---------------|
| `/admin/users` | UsersView | admin, ds_annotator, asap_pm |
| `/admin/teams` | TeamsView | admin, ds_annotator |
| `/admin/krt-editor/resource-types` | ResourceTypesView | admin, ds_annotator |
| `/admin/krt-editor/validation-rules` | AppConfigView | admin |
| `/admin/enrichments` | EnrichmentListView | admin, ds_annotator |

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

**Key computed:** `isAuthenticated`, `userRole`, `userTeams`, `isRealAdmin`, `effectiveRole` (respects `viewAsRole`), `isAuth0User`, `isAdmin`, `isStaff`, plus a family of capability flags that mirror the backend rules: `canCreateSubmission`, `canDeleteSubmission`, `canHideSubmission`, `canEditSubmission(submission)`, `canAccessSubmission(submission)`, `canManageUsers`, `canViewUsers`, `canManageTeams`, `canEditAnyUser`, `canEditAdminUsers`, `canDeleteUsers`, `canManageResourceTypes`, `canManageEnrichments`, `canManageValidationRules`, `canViewJobInternals`, `canManageJobs`.

**Key actions:** `login(email, password)`, `auth0PasswordLogin(email, password)`, `register(...)`, `logout()` (redirects to `auth0LogoutUrl` when present), `fetchCurrentUser()`, `refreshAccessToken()`, `setAuth(user) / clearAuth()`, `setViewAsRole(role) / clearViewAsRole()`, `initialize()`.

### Submission Store (`submission.store.js`)

Manages submission CRUD, filtering, pagination, and file tracking.

**Key state:** `submissions`, `hiddenSubmissions`, `currentSubmission`, `latestFiles`, `pagination`

**Key actions:** `fetchSubmissions(params)`, `fetchSubmission(id)`, `createSubmission()`, `updateSubmission()`, `deleteSubmission()`, `processNewVersion()`, `hideSubmission()`, `unhideSubmission()`

### KRT Store (`krt.store.js`)

Manages KRT table data, cell editing, validation, and AI suggestions.

**Key state:** `rows`, `validationErrors`, `aiSuggestions`, `editingCell`, `summary`

**Key computed:** `getRowErrors(rowId)`, `getRowSuggestions(rowId)`, `getCellSuggestion(rowId, column)`, `addRowSuggestions`, `deleteRowSuggestions`

**Key actions:** `fetchKRT()`, `uploadKRT()`, `updateCell()`, `batchUpdateCells()`, `addRow()`, `deleteRow()`, `validate()`, `fetchAiSuggestions()`, `updateSuggestionStatus()`

**Change sources:** `manual`, `ai_suggestion`, `krt_validation`

### Notification Store (`notification.store.js`)

Toast notification system with auto-dismiss.

**Actions:** `success()`, `error()`, `warning()`, `info()`, `remove()`, `clear()`

### Other Stores

- **Teams Store** (`teams.store.js`) — team CRUD with `activeTeams` computed
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

### `useModal`

Manages modal open/close state with optional data payload and `onOpen`/`onClose` callbacks.

### `useConfirmation`

Browser `window.confirm()` wrapper with `confirm(message, action)` and `confirmDelete(itemName, action)` helpers.

### `useToggleSelection`

Multi-select state for checkboxes and bulk operations: `toggle()`, `isSelected()`, `clear()`, `set()`.

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
| `krt.service.js` | `getData`, `upload` (2 min timeout), `updateRow`, `addRow`, `deleteRow`, `validate`, `download` |
| `pdf.service.js` | `upload` (2 min timeout), `getAnalysisStatus`, `getFindings`, `triggerAnalysis`, `extractDAS` |
| `markdown.service.js` | `triggerConvert` |
| `job.service.js` | `getJobs`, `runAllProcesses`, `advanceJob`, `getJobResponseUrl` |
| `suggestion.service.js` | `getSuggestions`, `approveSuggestion`, `rejectSuggestion` |
| `orcid.service.js` | `getAuthors`, `triggerExtraction` |
| `datasets.service.js` | `getMentions`, `triggerDetection` |
| `software.service.js` | `getMentions`, `triggerDetection` |
| `materials.service.js` | `getMentions`, `triggerDetection` |
| `protocols.service.js` | `getMentions`, `triggerDetection` |
| `identifier-detection.service.js` | `getMentions`, `triggerDetection` |
| `report.service.js` | `generate`, `list`, `getById`, `download` |
| `file.service.js` | `download` |
| `enrichment-list.service.js` | Single service backing every category — list (cross- or per-category), `getCounts`, `getById`, `create`, `update`, `remove`, `importEntries`, `exportCsv` |
| `teams.service.js` | `list`, `getCodes`, `create`, `update`, `delete` |
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

- **KRTEditor** — main table editor with inline cell editing, validation error display, and AI suggestion indicators
- **KRTCellEditModal** — modal for editing cells with longer content

### Submission Workflow

- **StepIndicator** — visual 5-step progress indicator
- **StepHelpPanel** — contextual help text for each workflow step
- **SubmissionHeader** — submission metadata display with edit/action buttons
- **JobStatusPanel** — background job status cards with "show more" detail modals
- **EditMetadataModal** — edit submission title and DAS
- **NewRoundModal** — start a new submission round (revision)

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
