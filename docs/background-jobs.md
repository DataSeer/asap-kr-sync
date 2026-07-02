# Background Jobs

The application uses **pg-boss** (PostgreSQL-based job queue) for asynchronous background processing. Jobs are tracked in the `submission_jobs` table, and an orchestrator manages dependencies between jobs. The frontend polls for status updates with exponential backoff.

> This document covers the **queue & orchestration layer** (how jobs are scheduled, sequenced, retried, and polled).
> For what each module *does and how it works internally*, see [background-modules.md](./background-modules.md).

## Queue Configuration

pg-boss runs in a dedicated `pgboss` schema, separate from application tables.

| Setting | Value |
|---------|-------|
| Archive completed jobs | 24 hours |
| Delete archived jobs | 7 days |
| Monitor state interval | 30 seconds |
| Maintenance interval | 120 seconds |
| Graceful shutdown timeout | 30 seconds |

## Queues and Job Types

| Queue Name | Job Type Constant | Purpose |
|------------|-------------------|---------|
| `das-extraction` | `DAS_EXTRACTION` | Extract Data Availability Statement from PDF |
| `software-detection` | `SOFTWARE_DETECTION` | Detect software mentions via Softcite |
| `orcid-extraction` | `ORCID_EXTRACTION` | Extract author ORCIDs via GROBID + OpenAlex |
| `markdown-convert` | `MARKDOWN_CONVERT` | Convert PDF to Markdown (MarkItDown subprocess or Modal/Docling) |
| `datasets-detection` | `DATASETS_DETECTION` | Detect dataset mentions (langextract signals + Gemini consolidation) |
| `materials-detection` | `MATERIALS_DETECTION` | Detect lab material mentions via Google Gemini |
| `protocols-detection` | `PROTOCOLS_DETECTION` | Detect protocol mentions via Google Gemini |
| `identifier-detection` | `IDENTIFIER_DETECTION` | Scan markdown against curated enrichment lists for DOIs/RRIDs/accessions/catalogs (no external API) |
| `pdf-analysis` | `PDF_ANALYSIS` | Build the Generated KRT — LM-consolidate (Gemini) the merged detection candidates, with a rule-based merge fallback |
| `suggestion-generation` | `SUGGESTION_GENERATION` | AI Suggestions — Gemini compares author KRT vs Generated KRT and emits per-resource decisions (LM-only, no fallback) |
| `report-generation` | `REPORT_GENERATION` | Generate Excel reports (ad-hoc, not part of the PDF pipeline) |

### Timeout and Retry Configuration

Each queue derives its timeout from the corresponding API timeout environment variable:

| Queue | Env Var for Timeout | Default Timeout | Retry Limit | Retry Delay |
|-------|---------------------|-----------------|-------------|-------------|
| DAS Extraction | `DAS_EXTRACTION_API_TIMEOUT` | 120s (2 min) | 2 | 60s |
| Software Detection | `SOFTCITE_API_TIMEOUT` | 600s (10 min) | 2 | 60s |
| ORCID Extraction | `GROBID_API_TIMEOUT` | 30s | 2 | 30s |
| Markdown Convert | `PDF_MARKDOWN_TIMEOUT` | 120s (2 min) | 2 | 30s |
| Datasets Detection | `DATASETS_DETECTION_API_TIMEOUT` | 300s (5 min) | 2 | 60s |
| Materials Detection | `MATERIALS_DETECTION_API_TIMEOUT` | 300s (5 min) | 2 | 60s |
| Protocols Detection | `PROTOCOLS_DETECTION_API_TIMEOUT` | 300s (5 min) | 2 | 60s |
| Identifier Detection | — (fixed) | 60s | 1 | 30s |
| PDF Analysis | `KRT_GENERATION_API_TIMEOUT` | 300s (5 min) | 2 | 60s |
| Suggestion Generation | `KRT_COMPARISON_API_TIMEOUT` | 300s (5 min) | 2 | 60s |
| Report Generation | — (fixed) | 300s (5 min) | 2 | 60s |

**Job expiry formula:**
```
expireInSeconds = max(120, ceil(apiTimeoutMs / 1000) + 60)
```

**Maximum total duration** (all retries + delays):
```
maxTotalSeconds = expireInSeconds × (retryLimit + 1) + retryDelay × retryLimit
```

### Worker Concurrency

| Job Type | Concurrency |
|----------|-------------|
| PDF Analysis | 1 |
| Suggestion Generation | 1 |
| DAS Extraction | 2 |
| Software Detection | 1 |
| ORCID Extraction | 2 |
| Markdown Convert | 2 |
| Datasets Detection | 1 |
| Materials Detection | 1 |
| Protocols Detection | 1 |
| Identifier Detection | 1 |
| Report Generation | 2 |

## Pipeline

PDF upload triggers a pipeline of parallel and dependent jobs:

```mermaid
graph TD
    PDF[PDF Upload] --> SW[Software Detection]
    PDF --> ORCID[ORCID Extraction]
    PDF --> MD[Markdown Convert]

    MD --> DAS[DAS Extraction]
    MD --> ID[Identifier Detection]
    MD --> DS[Datasets Detection]
    MD --> MAT[Materials Detection]
    MD --> PROT[Protocols Detection]

    KRTV{{KRT validated?<br/>status past step_krt}}
    KRTV -.->|gate: krt_curated| DS
    KRTV -.->|gate: krt_curated| MAT
    KRTV -.->|gate: krt_curated| PROT

    DAS --> PA[PDF Analysis]
    SW --> PA
    DS --> PA
    MAT --> PA
    PROT --> PA
    ID --> PA

    PA --> SG[Suggestion Generation]
    ORCID --> SG

    DAS -.->|status.detected = false| PI{{pending_input}}
    PI -.->|User advances| PA

    style PDF fill:#3b82f6,color:#fff
    style DAS fill:#f59e0b,color:#fff
    style SW fill:#10b981,color:#fff
    style ORCID fill:#8b5cf6,color:#fff
    style MD fill:#06b6d4,color:#fff
    style DS fill:#ec4899,color:#fff
    style MAT fill:#14b8a6,color:#fff
    style PROT fill:#f97316,color:#fff
    style ID fill:#a855f7,color:#fff
    style PA fill:#ef4444,color:#fff
    style SG fill:#db2777,color:#fff
    style PI fill:#6b7280,color:#fff
    style KRTV fill:#6b7280,color:#fff
```

**KRT-validation gate.** Datasets, Materials, and Protocols detection seed the LM
with the author's KRT rows, so running them against a still-draft KRT would feed
the models unvalidated data. These three additionally **gate on `krt_curated`**
(the submission status has moved past `draft`/`step_krt`): until the author
validates the KRT, the jobs stay in `waiting` and the jobs API reports
`waitingReason: 'krt_validation'`. Unlike the DAS `pending_input` gate, this
needs **no manual action** — the jobs advance by themselves once the status
changes. Software, ORCID, DAS, Markdown Convert, and Identifier detection are
unaffected and still start as soon as their dependencies are met, so the
expensive markdown conversion still overlaps with curation.

ORCID Extraction is intentionally **not** an input to PDF Analysis — its output writes to `submission.authors`, not the Generated KRT. **Suggestion Generation** (AI Suggestions) runs last and depends on PDF Analysis, which already gates on every KRT detector. Because PDF Analysis and Suggestion Generation sit downstream of the three gated detectors, they inherit the KRT-validation gate transitively — the Generated KRT always diffs the curated KRT.

### Pipeline Definition

| Job Type | Depends On | Submission-State Gate | Auto-Advance Condition |
|----------|-----------|-----------------------|------------------------|
| DAS Extraction | Markdown Convert | — | Always |
| Software Detection | (none) | — | Always |
| ORCID Extraction | (none) | — | Always |
| Markdown Convert | (none) | — | Always |
| Identifier Detection | Markdown Convert | — | Always |
| Datasets Detection | Markdown Convert | `krt_curated` | Always (falls back gracefully if markdown unavailable) |
| Materials Detection | Markdown Convert | `krt_curated` | Always |
| Protocols Detection | Markdown Convert | `krt_curated` | Always |
| PDF Analysis | DAS + Software + Datasets + Materials + Protocols + Identifier Detection | — (inherited transitively) | Only if DAS extraction `result.status.detected === true` |
| Suggestion Generation | PDF Analysis | — (inherited transitively) | Always (runs last in the pipeline) |

### Pipeline Rules

- Jobs with no dependencies and no gate start immediately with status `queued`
- Jobs with dependencies start as `waiting` until all dependencies reach a terminal state (`complete` or `failed`)
- After any job completes or fails, the orchestrator checks dependent jobs
- **Conditional (job-result) gate** — if a job-result gate fails (e.g., DAS not extracted), the dependent job moves to `pending_input` and waits for the user to click **Advance**
- **Submission-state gate** — a job whose `gate` (e.g. `krt_curated`) is not yet satisfied stays in `waiting` (never `pending_input`). It needs no manual action: the status-change handler re-drives the pipeline on every submission transition, and the periodic reconciler re-checks gated jobs each sweep, so the job advances on its own once the gate opens

## Job Statuses

| Status | Meaning | Transitions To |
|--------|---------|----------------|
| `waiting` | Waiting for dependencies to complete, or for a submission-state gate (e.g. `krt_curated`) to open | `queued` or `pending_input` |
| `pending_input` | Waiting for user action (a job-result gate condition failed, e.g. DAS not detected) | `queued` (manual advance) |
| `queued` | Added to pg-boss queue, waiting for worker | `processing` |
| `processing` | Worker is actively processing | `complete` or `failed` |
| `complete` | Finished successfully | (terminal) |
| `failed` | Failed after all retries exhausted | (terminal) |

### Typical Lifecycle

```mermaid
stateDiagram-v2
    [*] --> waiting : Job created (has dependencies)
    [*] --> queued : Job created (no dependencies)

    waiting --> queued : Dependencies met and gate open
    waiting --> waiting : Submission-state gate not yet satisfied (auto-retried)
    waiting --> pending_input : Job-result gate condition failed

    pending_input --> queued : User clicks Advance

    queued --> processing : Worker picks up job
    processing --> complete : Success
    processing --> failed : Error (retries exhausted)

    complete --> [*]
    failed --> [*]
```

**Happy path:** `waiting → queued → processing → complete → [pipeline advances dependent jobs]`

**Job-result gate (e.g., PDF Analysis when DAS not extracted):** `waiting → pending_input → [user clicks Advance] → queued → processing → complete`

**Submission-state gate (e.g., Datasets/Materials/Protocols before KRT validation):** `waiting → [author validates KRT — status leaves step_krt] → queued → processing → complete` (no manual advance; the orchestrator re-drives on the status change)

## Job Data Payloads

Data passed to workers when a job starts:

| Job Type | Data Fields |
|----------|-------------|
| DAS Extraction | `submissionId`, `submissionJobId` |
| Software Detection | `submissionId`, `submissionJobId` |
| ORCID Extraction | `submissionId`, `submissionJobId` |
| Markdown Convert | `submissionId`, `submissionJobId` |
| Datasets Detection | `submissionId`, `submissionJobId` |
| Materials Detection | `submissionId`, `submissionJobId` |
| Protocols Detection | `submissionId`, `submissionJobId` |
| Identifier Detection | `submissionId`, `submissionJobId` |
| PDF Analysis | `submissionId`, `submissionJobId`, `userId` |
| Suggestion Generation | `submissionId`, `submissionJobId`, `userId` |
| Report Generation | `submissionId`, `submissionJobId`, `type`, `userId` |

## Result Summaries

Each job stores a structured result blob on completion. Every entry has the same outer envelope (`status`, `service`, `counts`, `timing`, `data`, `files`) — the table below lists the **distinguishing** keys per job type. The `service` block is `{ config: {state, enabled, demoEnabled}, outcome: {state, source, failReason?, externalError?} }` for every job. The `files` map carries S3 keys for raw API responses captured by the job logger.

| Job Type | Distinguishing keys |
|----------|---------------------|
| DAS Extraction | `status.detected` (boolean — drives the PDF Analysis auto-advance gate); `data.das` (the extracted text); `files['das-extractor-response' \| 'demo-das']` |
| Software Detection | `counts: {total, unique, enriched}`; `data: {items, meta}`; `files['softcite-response' \| 'demo-software']` |
| ORCID Extraction | `counts: {authors, orcids}`; `data: {doi}`; `files['grobid-header', 'openalex-response']`. Items themselves go to `submission.authors`, not `data.items` |
| Markdown Convert | `data: {fileId, provider, markdownLength}`; `timing.totalMs`. The markdown text itself is uploaded to S3 as a File row of type `markdown` |
| Datasets Detection | `counts: {total, unique, highRelevance}`; `timing: {totalMs, apiMs, signalMs, enrichMs}`; `data: {items, meta}`; `files['langextract-signals', 'gemini-consolidation']` |
| Materials Detection | `counts: {total, unique, highRelevance}`; `data: {items, meta}`; `files['gemini-response']` |
| Protocols Detection | `counts: {total, unique, highRelevance}`; `data: {items, meta}`; `files` includes the raw Gemini response and the extracted JSON |
| Identifier Detection | `counts`; `timing: {totalMs, indexMs, scanMs}`; `data: {items, meta: {byRelevance: {HIGH, MEDIUM, LOW}, byCategory: {software, materials, datasets, protocols}}}`; `files['detection-results', 'identifier-scan']` |
| PDF Analysis | `counts: {resources, contributors, multiSource}`; `data: {items}` (the Generated KRT); `files['generated-krt']` |
| Suggestion Generation | `counts` per decision (`add`/`skip`/`update`/`remove`); `data: {suggestions}` — the **persisted** AI Suggestions list (not recomputed on read), each carrying its decision, reason, and contributing detection module(s) |
| Report Generation | `data: {reportId, fileUrl}` |

## API Endpoints

### `GET /api/submissions/:id/jobs`

Returns all jobs for the submission's current round. Each job includes status, result, error message, retry count, timing, and configuration (expiry, retry limit, max total seconds).

### `POST /api/submissions/:id/processes/run`

Starts (or re-runs) all pipeline processes for a submission. Creates `SubmissionJob` records and enqueues independent jobs.

### `POST /api/submissions/:id/jobs/:jobType/advance`

Manually advances a `pending_input` job to `queued`. Only works for jobs in `pending_input` status.

## Job Logging & Raw Response Caching

Each background job uses a **JobLogger** that captures structured logs and raw API responses:

### Structured Logs (`SubmissionJob.logs` JSONB)

Array of log entries persisted in PostgreSQL:

```json
[
  { "ts": "2026-04-07T12:00:00Z", "step": "download_pdf", "message": "Downloading PDF from S3", "data": { "fileName": "manuscript.pdf" } },
  { "ts": "2026-04-07T12:00:45Z", "step": "extract_signals_done", "message": "Signal extraction complete", "data": { "totalExtractions": 49, "durationMs": 45844 } }
]
```

### Raw API Responses (`SubmissionJob.result.files` → S3)

Large API responses are uploaded to S3 and referenced by S3 key on the job's `result.files` map (there is no separate `raw_responses` column):

```json
{
  "langextract-signals": "{manuscriptId}/round-1/jobs/datasets_detection/langextract-signals.json",
  "gemini-consolidation": "{manuscriptId}/round-1/jobs/datasets_detection/gemini-consolidation.json"
}
```

### S3 Structure

All files for a submission are organized by manuscript ID and round:

```
{bucketPrefix}{manuscriptId}/round-{n}/
  ├── krt/              KRT files
  ├── pdf/              Working PDF
  ├── pdf_original/     Original uploaded PDF
  ├── supplemental/     Supplemental methods files
  ├── supplemental_pdf/ PDF version of supplemental
  ├── markdown/         PDF-to-Markdown conversions
  ├── reports/          Generated reports
  └── jobs/             Process logs & raw responses
      ├── {jobType}/
      │   ├── logs.json
      │   └── {response-name}.json
      └── ...
```

### API

`GET /api/submissions/:id/jobs/:jobType/responses/:responseName` — returns a presigned S3 download URL for a raw response file.

### UI

- **Job popup**: "View logs" link opens a modal with the structured log timeline
- **Show more modal**: Logs tab with timestamps, steps, messages, and expandable data
- **Raw responses**: Download links visible to admin/ds_annotator roles

## Frontend Polling

The `useJobPoller` composable polls job status with exponential backoff:

| Parameter | Value |
|-----------|-------|
| Initial interval | 3 seconds |
| Max interval | 30 seconds |
| Backoff factor | 1.5× per poll |
| Max poll duration | 20 minutes |

**Behavior:**
- Fetches jobs on mount
- Continues polling while any job is in a running state (`waiting`, `queued`, `processing`)
- Stops polling when all jobs reach terminal states
- `refresh()` resets the backoff to poll quickly again

**Event callbacks** (fire only on observed status transitions, not on first fetch):
- `onJobComplete(type, callback)` — when a job transitions to `complete`
- `onJobFailed(type, callback)` — when a job transitions to `failed`
- `onJobPendingInput(type, callback)` — when a job transitions to `pending_input`

## Key Files

| File | Purpose |
|------|---------|
| `src/backend/services/queue/job-queue.service.js` | pg-boss setup, queue config, handler registration |
| `src/backend/services/queue/orchestrator.service.js` | Pipeline definition, dependency checking, job advancement |
| `src/backend/services/queue/workers.js` | Worker handlers for all job types |
| `src/backend/services/queue/job-logger.service.js` | Structured logging and raw response caching for jobs |
| `src/backend/models/SubmissionJob.js` | Job model with status tracking, logs, and raw responses |
| `src/backend/controllers/jobs.controller.js` | API endpoints for job management |
| `src/frontend/src/composables/useJobPoller.js` | Frontend polling with backoff |
| `src/frontend/src/components/submission/JobStatusPanel.vue` | Job status display in UI |
