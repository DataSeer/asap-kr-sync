# Frontend

The frontend is a Vue 3 Single-Page Application using the Composition API, Pinia for state management, and Tailwind CSS for styling.

## Technology Stack

| Library | Version | Purpose |
|---------|---------|---------|
| Vue | 3.x | UI framework (Composition API, `<script setup>`) |
| Vite | 5.x | Build tool and dev server |
| Pinia | 2.x | State management |
| Vue Router | 4.x | Client-side routing |
| Axios | 1.6 | HTTP client |
| Tailwind CSS | 3.4 | Utility-first CSS framework |
| AG Grid | 31.x | Data grid component |
| Headless UI | 1.7 | Accessible unstyled UI components |
| Heroicons | 2.1 | SVG icons |
| VeeValidate | 4.12 | Form validation |
| Yup | 1.3 | Schema validation |
| VueUse | 10.7 | Composition API utilities |

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
| `/admin/enrichments/software-list` | SoftwareListView | admin, ds_annotator |
| `/admin/enrichments/materials-list` | MaterialsListView | admin, ds_annotator |
| `/admin/enrichments/datasets-list` | DatasetsListView | admin, ds_annotator |
| `/admin/enrichments/protocols-list` | ProtocolsListView | admin, ds_annotator |

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

Manages authentication state, tokens, and role-based permissions.

**Key state:** `user`, `token`, `refreshToken`, `viewAsRole` (admin simulation)

**Key computed:** `isAuthenticated`, `effectiveRole` (respects viewAsRole), `canManageUsers`, `canManageTeams`

**Key actions:** `login()`, `logout()`, `fetchCurrentUser()`, `refreshAccessToken()`, `handleAuth0Callback()`, `setViewAsRole()`

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
- Timeout: 30 seconds
- Request interceptor: adds `Authorization: Bearer` header
- Response interceptor: handles 401 with automatic token refresh and retry

### Services

| Service | Key Methods |
|---------|------------|
| `auth.service.js` | `login`, `register`, `logout`, `refreshToken`, `getCurrentUser` |
| `submission.service.js` | `list`, `getById`, `create`, `update`, `delete`, `getChanges`, `hide`, `unhide`, `getFilterOptions`, `uploadSupplemental`, `processNewVersion` |
| `krt.service.js` | `getData`, `upload` (2min timeout), `updateRow`, `addRow`, `deleteRow`, `validate`, `download` |
| `pdf.service.js` | `upload` (2min timeout), `getAnalysisStatus`, `getFindings`, `triggerAnalysis`, `extractDAS` |
| `job.service.js` | `getJobs`, `runAllProcesses`, `advanceJob` |
| `suggestion.service.js` | `getSuggestions`, `approveSuggestion`, `rejectSuggestion` |
| `orcid.service.js` | `getAuthors`, `triggerExtraction` |
| `datasets.service.js` | `getMentions`, `triggerDetection` |
| `software.service.js` | `getMentions`, `triggerDetection` |
| `report.service.js` | `generate`, `list`, `getById`, `download` |
| `file.service.js` | `download` |
| `software-list.service.js` | `list`, `getById`, `create`, `update`, `remove`, `importEntries`, `exportCsv` |
| `materials-list.service.js` | `list`, `getCounts`, `getById`, `create`, `update`, `remove`, `importEntries`, `exportCsv` |
| `datasets-list.service.js` | `list`, `getById`, `create`, `update`, `remove`, `importEntries`, `exportCsv` |
| `protocols-list.service.js` | `list`, `getById`, `create`, `update`, `remove`, `importEntries`, `exportCsv` |
| `teams.service.js` | `list`, `getCodes`, `create`, `update`, `delete` |
| `resourceTypes.service.js` | `list`, `getNames`, `create`, `update`, `delete` |
| `appConfig.service.js` | `list`, `get`, `save`, `delete` |
| `profile.service.js` | `get`, `update` |

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
