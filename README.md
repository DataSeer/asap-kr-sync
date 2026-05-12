# ASAP KR-Sync

A full-stack web application for managing Key Resources Tables (KRT) in academic manuscript submissions. It guides users through a structured workflow — from KRT upload and validation, through PDF analysis with AI-powered resource extraction, to final report generation.

## Key Features

- **KRT Management** — Upload, validate, and edit Key Resources Tables (CSV, XLSX, XLS, ODS)
- **AI-Powered PDF Analysis** — Automatically extract resources, software mentions, and Data Availability Statements from manuscripts
- **Software Detection** — Detect software mentions via the Softcite API with reference list enrichment
- **Datasets Detection** — Identify dataset mentions in manuscripts using Google Gemini with structured relevance scoring
- **Materials Detection** — Identify lab materials/reagents in manuscripts using Google Gemini with KRT suggestion generation
- **Protocols Detection** — Identify protocol mentions in manuscripts using Google Gemini with KRT suggestion generation
- **ORCID Extraction** — Identify authors and ORCIDs from PDFs using GROBID, OpenAlex, and the ORCID API
- **Enrichment Lists** — Curated reference lists for all KRT resource types (software, datasets, materials, protocols) with standardized KRT columns, CSV import/export, and admin management pages
- **Report Generation** — Export results as Excel spreadsheets or Google Sheets
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
| [Getting Started](./docs/getting-started.md) | Prerequisites, installation, configuration, running, npm scripts |
| [Architecture](./docs/architecture.md) | System architecture, project structure, workflow overview |
| [Database](./docs/database.md) | Schema, tables, columns, migrations |
| [API Reference](./docs/api-reference.md) | All REST API endpoints organized by resource |
| [Submission Workflow](./docs/submission-workflow.md) | Detailed 5-step workflow, user actions, conditions, all paths |
| [Authentication](./docs/authentication.md) | JWT flow, Auth0 integration, roles, middleware, rate limiting |
| [Background Jobs](./docs/background-jobs.md) | Job queue, pipeline, workers, statuses, polling |
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
  ├── DAS Extraction        (immediate)
  ├── Software Detection    (immediate)
  ├── ORCID Extraction      (immediate)
  ├── Markdown Convert      (immediate)
  │   └── Datasets Detection  (after markdown convert)
  ├── Materials Detection   (immediate)
  └── Protocols Detection   (immediate)
                                ↓
                        PDF Analysis
                        (after DAS extraction)
```

## Project Structure

```
asap-kr-sync/
├── conf/                   Static configuration (rate-limits.json)
├── deploy/                 Deployment files (systemd, entrypoint)
├── docs/                   Documentation
├── migrations/             Sequelize database migrations
├── seeders/                Database seed data
├── src/
│   ├── backend/
│   │   ├── config/         Environment-based configuration
│   │   ├── controllers/    Route handlers
│   │   ├── middleware/     Auth, validation, rate limiting
│   │   ├── models/         Sequelize models
│   │   ├── routes/         Express route definitions
│   │   └── services/       Business logic (auth, krt, pdf, queue, orcid, software, datasets, materials, protocols, reports)
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
