# ASAP KR-Sync

A full-stack web application for managing Key Resources Tables (KRT) in academic manuscript submissions. It guides users through a structured workflow — from KRT upload and validation, through PDF analysis with AI-powered resource extraction, to final report generation.

## Key Features

- **KRT Management** — Upload, validate, and edit Key Resources Tables (CSV, XLSX)
- **AI-Powered PDF Analysis** — Consolidate every detection's findings into a Generated KRT, then surface diff-based suggestions for the user to accept or reject
- **Software Detection** — Detect software/code via two engines unioned: the Softcite NER service (tool names in prose) plus an optional Gemini pass that catches what a name recogniser cannot — `RRID:SCR_` tokens, GitHub/PyPI/CRAN links, and custom code promised in a data-availability statement
- **Datasets Detection** — Identify dataset mentions in manuscripts using Google Gemini with structured relevance scoring (two-pass: langextract signal extraction + Gemini consolidation)
- **Materials Detection** — Identify lab materials/reagents in manuscripts using Google Gemini, cue-driven (antibodies, plasmids, cell lines, organisms, reagents). Runs on every submission, with or without an author KRT
- **Protocols Detection** — Identify protocol mentions in manuscripts using Google Gemini with KRT suggestion generation
- **Identifier Detection** — Scan the converted manuscript markdown against the curated enrichment lists to recover identifier-based matches (DOIs, RRIDs, accessions, catalog numbers) across every KRT resource category in a single pass, plus a list-free sweep that recognizes published-protocol venues (protocols.io, Nature Protocols, JoVE, Bio-protocol, …) from the identifier shape alone
- **KRT Grounding** — Reconcile the author's KRT against everything detection found: per author row, `confirmed` / `incomplete` / `partial` / `not_detected`, each backed by a verified manuscript quote. Deterministic matching (identifier → alias → name → partial name) plus a targeted LM search over the rows nothing matched. `partial` covers the case where the author writes a packaged construct (`AAV5.CaMKII.GCaMP6f.WPRE.SV40`) and the paper names the component (`GCaMP6f`) — located, but never used to propose a value. Never modifies the author's data — a row the manuscript never mentions is tagged, not changed
- **ORCID Extraction** — Identify authors and ORCIDs from PDFs using GROBID, OpenAlex, and the ORCID API
- **Enrichment Lists** — Curated reference lists for all KRT resource types (software, datasets, materials, protocols) with standardized KRT columns, CSV import/export, and admin management pages
- **Report Generation** — Export results as Excel spreadsheets (Google Sheets export is reserved but not yet implemented)
- **Multi-Round Workflow** — Support for manuscript revisions with full change tracking
- **Role-Based Access** — Four user roles (author, asap_pm, ds_annotator, admin) with team-based submission scoping
- **Dual Authentication** — Local JWT and Auth0 (OAuth2/OIDC)

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+, Express.js |
| Frontend | Vue 3 (Composition API), Vite, Pinia, Tailwind CSS |
| Database | PostgreSQL 15+, Sequelize ORM |
| Job Queue | pg-boss (PostgreSQL-based) |
| File Storage | AWS S3 (MinIO for local dev) |
| Authentication | JWT + Auth0 |
| Containerization | Docker (multi-stage build) |

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Start local services (MinIO for S3)
docker-compose up -d minio

# Run database migrations
npm run migrate

# Start development servers (backend + frontend)
npm run dev
```

- **Backend API**: http://localhost:3000
- **Frontend**: http://localhost:5173
- **MinIO Console**: http://localhost:9001 (minioadmin / minioadmin)

See [Getting Started](./docs/getting-started.md) for full setup instructions.

## Documentation

| Document | Description |
|----------|-------------|
| ⭐ [Master Setup Guide](./docs/master-setup-guide.md) | **Start here** — self-contained zero-to-deployed guide: config files, module workflow, DB structure, local + production deployment |
| [Getting Started](./docs/getting-started.md) | Prerequisites, installation, configuration, running, npm scripts |
| [Architecture](./docs/architecture.md) | System architecture, project structure, workflow overview |
| [Database](./docs/database.md) | Schema, tables, columns, migrations |
| [API Reference](./docs/api-reference.md) | All REST API endpoints organized by resource |
| [Submission Workflow](./docs/submission-workflow.md) | Detailed 5-step workflow, user actions, conditions, all paths |
| [KRT Validation Rules](./docs/krt-validation-rules.md) | What triggers an error / warning / silent pass on each KRT column, per-type identifier acceptance, and how errors gate "Continue" |
| [KRT Editor](./docs/krt-editor.md) | Every feature of the table component — editing, quick actions, validation feedback, suggestion review, bulk operations, change visualisation, and what it deliberately does *not* do |
| [Authentication](./docs/authentication.md) | JWT flow, Auth0 integration, roles, middleware, rate limiting |
| [Background Jobs](./docs/background-jobs.md) | Job queue, pipeline, workers, statuses, polling |
| [Background Modules](./docs/background-modules.md) | Module-by-module reference — each detector, its engine, the 4-stage contract, demo fallback, and how outputs become the Generated KRT |
| [External APIs](./docs/external-apis.md) | GROBID, OpenAlex, ORCID, Softcite, Gemini, LM APIs, S3, Google Sheets |
| [Frontend](./docs/frontend.md) | Vue 3 SPA architecture, routing, stores, composables, components |
| [Environment Variables](./docs/environment-variables.md) | All environment variables with descriptions and defaults |
| [Deployment](./docs/deployment.md) | Docker, Docker Compose, systemd, production setup |
| [EC2 Deployment](./docs/ec2-deployment.md) | AWS EC2 deployment guide |
| [Auth0 Integration](./docs/auth0-integration.md) | Detailed Auth0 setup and configuration |
| [User Guide](./docs/user-guide.md) | End-user guide for the application |

## Submission Workflow

```
1. KRT Upload    →  2. PDF Analysis  →  3. Review  →  4. Availability  →  5. Report
   (step_krt)        (step_pdf)          (step_review)   (step_as)          (step_report)
```

When a PDF is uploaded, background jobs run in parallel:

```
PDF Upload
  ├── ORCID Extraction       (immediate)
  └── Markdown Convert       (immediate)
        ├── Software Detection    (after markdown convert)
        ├── DAS Extraction        (after markdown convert)
        ├── Identifier Detection  (after markdown convert)
        ├── Datasets Detection    (after markdown convert)
        ├── Materials Detection   (after markdown convert)
        └── Protocols Detection   (after markdown convert)
                                       ↓
                              KRT Grounding
                              (after every detector; waits for KRT validation)
                                       ↓
                              PDF Analysis (consolidator)
                              (after DAS + Software + Datasets +
                               Materials + Protocols + Identifier +
                               Grounding; auto-advances if DAS was
                               detected, otherwise waits for user input)
```

Detection is **KRT-blind**: no detector reads the author's table, so every
detector starts as soon as the markdown exists and results arrive without the
pipeline stalling on a KRT that may never come. The author's table enters the
pipeline one step later, at **KRT Grounding**, as a query rather than a seed —
which is what makes "did we actually find this row in the PDF?" answerable. That
step waits for the KRT to be validated (submission status past `step_krt`), and
PDF Analysis inherits the gate through it. See
[Background Jobs](./docs/background-jobs.md) for the full gating rules.

PDF Analysis is an in-app step (no external API) that merges the
items produced by every detection into the Generated KRT — feeding
the suggestions the user sees in step 2. ORCID results live on
`submission.authors` and don't feed the consolidator.

## Project Structure

```
asap-kr-sync/
├── conf/                   Static configuration (rate-limits.json)
├── deploy/                 Deployment files (systemd, entrypoint)
├── docs/                   Documentation
├── migrations/             Sequelize database migrations
├── scripts/                Operational tools — run against a real instance
│   ├── dev/                Localhost-only: feature development & quality evaluation
│   └── lib/                Shared helpers (spreadsheets, author KRT, report shapes)
├── seeders/                Database seed data
├── src/
│   ├── backend/
│   │   ├── config/         Environment-based configuration
│   │   ├── controllers/    Route handlers
│   │   ├── middleware/     Auth, validation, rate limiting
│   │   ├── models/         Sequelize models
│   │   ├── routes/         Express route definitions
│   │   └── services/       Business logic (auth, krt, pdf, pdf-analysis, queue, orcid, software, datasets, materials, protocols, identifier-detection, enrichment-list, reports, storage, suggestion)
│   └── frontend/
│       └── src/
│           ├── components/  Vue components (layout, krt, submission, common)
│           ├── composables/ Reusable logic (useJobPoller, useAsyncAction, etc.)
│           ├── router/      Vue Router with auth guards
│           ├── services/    API client services
│           ├── stores/      Pinia state management
│           └── views/       Page components (dashboard, submissions, admin)
├── docker-compose.yml      Local development services
├── Dockerfile              Production container build
└── package.json            Root workspace configuration
```
