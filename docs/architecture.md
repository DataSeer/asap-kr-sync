# Architecture Overview

ASAP KR-Sync is a full-stack web application for managing Key Resources Tables (KRT) in academic manuscript submissions. It follows a monorepo structure with a Node.js/Express backend and a Vue 3 frontend.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+ |
| **Backend Framework** | Express.js |
| **Frontend Framework** | Vue 3 (Composition API, `<script setup>`) |
| **Build Tool** | Vite |
| **State Management** | Pinia |
| **Database** | PostgreSQL + Sequelize ORM |
| **Job Queue** | pg-boss (PostgreSQL-based) |
| **File Storage** | AWS S3 (or MinIO for local dev) |
| **Authentication** | JWT (local) + Auth0 (OAuth2/OIDC) |
| **Styling** | Tailwind CSS |
| **Logging** | Winston |
| **Containerization** | Docker (multi-stage build) |

## Project Structure

```
asap-kr-sync/
├── conf/                          # Static configuration (rate-limits.json)
├── deploy/                        # Deployment files (systemd, entrypoint)
├── docs/                          # Documentation (this folder)
├── migrations/                    # Sequelize database migrations
├── scripts/                       # Utility scripts (init-db, generate-demo-data, benchmark, etc.)
├── seeders/                       # Database seed data
├── src/
│   ├── backend/
│   │   ├── config/                # Environment-based configuration modules
│   │   ├── controllers/           # Route handlers (request → response)
│   │   ├── data/                  # prompts/ (public, version-controlled .txt) + demo-findings/ (gitignored)
│   │   ├── middleware/            # Express middleware (auth, validation, CSRF, rate-limit, etc.)
│   │   ├── models/                # Sequelize model definitions
│   │   ├── routes/                # Express route definitions
│   │   ├── services/              # Business logic layer
│   │   │   ├── auth/              # Authentication (JWT, Auth0, refresh-token rotation)
│   │   │   ├── datasets/          # Datasets detection (langextract + Google Gemini)
│   │   │   ├── identifier-detection/  # Curated-list identifier scanner (DOIs, RRIDs, accessions, catalogs)
│   │   │   ├── krt/               # KRT parsing, validation, identifiers, author-KRT seeding (shared by software/protocols/materials)
│   │   │   ├── materials/         # Materials detection (Google Gemini)
│   │   │   ├── orcid/             # ORCID extraction (GROBID, OpenAlex, ORCID API)
│   │   │   ├── pdf/               # PDF processing, DAS extraction, markdown convert
│   │   │   ├── pdf-analysis/      # Generated KRT builder — rule-based merge then LM (Gemini) consolidation, rule-based fallback
│   │   │   ├── protocols/         # Protocols detection (Google Gemini, author-KRT seeded)
│   │   │   ├── queue/             # Job queue (pg-boss), orchestrator, workers
│   │   │   ├── reports/           # Excel report generation
│   │   │   ├── software/          # Software detection (Softcite)
│   │   │   ├── storage/           # S3 file operations
│   │   │   ├── suggestion/        # AI Suggestions — LM (Gemini) author-KRT vs Generated-KRT comparison (suggestion_generation job)
│   │   │   ├── enrichment-list.service.js  # Single shared service backing the four curated lists
│   │   │   └── config.service.js  # Dynamic config (teams, resource types, validation rules) from DB
│   │   └── utils/                 # Shared utilities (logger, errors, helpers, validators)
│   └── frontend/
│       └── src/
│           ├── assets/            # Static assets, demo data, styles
│           ├── components/        # Reusable Vue components
│           │   ├── common/        # Generic UI components
│           │   ├── krt/           # KRT editor components
│           │   ├── layout/        # App layout (header, sidebar)
│           │   └── submission/    # Submission workflow components
│           ├── composables/       # Vue composables (useJobPoller, etc.)
│           ├── router/            # Vue Router configuration
│           ├── services/          # API client services (Axios)
│           ├── stores/            # Pinia state management
│           └── views/             # Page-level components
│               ├── admin/         # Admin pages (users, teams, config, enrichment lists)
│               ├── auth/          # Login, register
│               ├── dashboard/     # Submission list
│               ├── profile/       # User profile
│               └── submissions/   # Submission workflow steps
├── .env.example                   # Environment variable template
├── docker-compose.yml             # Local development services
├── Dockerfile                     # Production container build
└── package.json                   # Root workspace configuration
```

## Backend Architecture

The backend follows a layered architecture:

```mermaid
flowchart LR
    R[Routes] --> M[Middleware]
    M --> C[Controllers]
    C --> S[Services]
    S --> DB[(Models / Database)]
    S --> API[External APIs]

    style R fill:#3b82f6,color:#fff
    style M fill:#f59e0b,color:#fff
    style C fill:#10b981,color:#fff
    style S fill:#8b5cf6,color:#fff
    style DB fill:#6b7280,color:#fff
    style API fill:#ec4899,color:#fff
```

- **Routes** define HTTP endpoints and attach middleware
- **Middleware** handles cross-cutting concerns (auth, validation, rate limiting)
- **Controllers** handle request/response parsing and delegate to services
- **Services** contain business logic and orchestrate data operations
- **Models** define database schema and relationships via Sequelize

## Frontend Architecture

The frontend is a Single-Page Application (SPA):

```mermaid
flowchart TD
    Router --> Views
    Views --> Components
    Views --> Stores
    Components --> Stores
    Stores --> Services[Services / API]
    Services --> Backend[Backend API]

    style Router fill:#3b82f6,color:#fff
    style Views fill:#10b981,color:#fff
    style Components fill:#8b5cf6,color:#fff
    style Stores fill:#f59e0b,color:#fff
    style Services fill:#ec4899,color:#fff
    style Backend fill:#6b7280,color:#fff
```

- **Router** handles navigation with auth guards and lazy-loaded routes
- **Views** are page-level components mapped to routes
- **Components** are reusable UI building blocks
- **Stores** (Pinia) manage shared application state
- **Services** wrap Axios calls to the backend API

## Submission Workflow

The application guides users through a 5-step workflow:

```mermaid
flowchart LR
    S1["1. KRT Upload\n(step_krt)"] --> S2["2. PDF Analysis\n(step_pdf)"]
    S2 --> S3["3. Review\n(step_review)"]
    S3 --> S4["4. Availability\n(step_as)"]
    S4 --> S5["5. Report\n(step_report)"]

    style S1 fill:#3b82f6,color:#fff
    style S2 fill:#f59e0b,color:#fff
    style S3 fill:#10b981,color:#fff
    style S4 fill:#8b5cf6,color:#fff
    style S5 fill:#ec4899,color:#fff
```

Each step has a corresponding status, view, and set of operations. Users can navigate back to previous steps and start new rounds (revisions) of the process. See [Submission Workflow](./submission-workflow.md) for the full detail of every step, user action, and transition path.

## Background Job Pipeline

PDF upload triggers parallel background jobs via pg-boss. PDF Analysis builds the Generated KRT (rule-based merge then LM consolidation) once every detection job is terminal (gated by whether DAS was detected); Suggestion Generation then runs last to produce the AI Suggestions:

```mermaid
graph TD
    PDF[PDF Upload] --> SW[Software Detection]
    PDF --> ORCID[ORCID Extraction]
    PDF --> MD[Markdown Convert]
    MD --> DAS[DAS Extraction]
    MD --> DS[Datasets Detection]
    MD --> MAT[Materials Detection]
    MD --> PROT[Protocols Detection]
    MD --> ID[Identifier Detection]
    KRTV{{KRT validated?}} -.->|gate: krt_curated| DS
    KRTV -.->|gate| MAT
    KRTV -.->|gate| PROT
    DAS --> PA[PDF Analysis]
    SW --> PA
    DS --> PA
    MAT --> PA
    PROT --> PA
    ID --> PA
    PA --> SG[Suggestion Generation]
    ORCID --> SG

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
    style KRTV fill:#6b7280,color:#fff
```

**Datasets, Materials, and Protocols detection are seeded with the author's KRT rows**, so they gate on `krt_curated` (submission status past `step_krt`): they stay in `waiting` until the author validates the KRT, then advance automatically — no manual action. ORCID Extraction is intentionally **not** a contributor to PDF Analysis — its output lives on `submission.authors`, not in the Generated KRT. PDF Analysis auto-advances when DAS was detected; if DAS extraction fails, the job parks at `pending_input` until the user supplies a DAS manually and clicks Advance. **Suggestion Generation** (the AI Suggestions / KRT comparison) runs last, depending on PDF Analysis (which already gates on every KRT detector); it is LM-only, so with no LM configured no suggestions are produced.

See [Background Jobs](./background-jobs.md) for details.

## User Roles

| Role | Access |
|------|--------|
| `author` | Own submissions only |
| `asap_pm` | Submissions from assigned teams |
| `ds_annotator` | All submissions, user/team management |
| `admin` | Full system access |

See [Authentication](./authentication.md) for details.
