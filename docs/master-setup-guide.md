# ASAP KR-Sync — Master Setup, Configuration & Deployment Guide

> **Audience:** people who are comfortable with a terminal and Docker, but who are **not** expected to know
> this codebase. If you can copy-paste shell commands and edit a text file, you can follow this guide.
> **Goal:** this single document is enough to stand the app up end-to-end. It links to the deeper
> per-topic docs where useful, but you should not *need* them to get a working deployment.
>
> **Deep-dive references** (optional): [Architecture](./architecture.md) · [Database](./database.md) ·
> [External APIs](./external-apis.md) · [Background Jobs](./background-jobs.md) ·
> [Background Modules](./background-modules.md) · [Authentication](./authentication.md) ·
> [Auth0 Integration](./auth0-integration.md) · [Environment Variables](./environment-variables.md) ·
> [Submission Workflow](./submission-workflow.md) · [EC2 Deployment](./ec2-deployment.md).

---

## 1. What you are deploying

ASAP KR-Sync is a full-stack web app that helps researchers/curators produce a correct **Key Resources
Table (KRT)** for a manuscript. A user uploads a manuscript PDF and a draft KRT; the app runs a fleet of
detection modules over the PDF, builds an "ideal" KRT, and shows the curator accept/reject **suggestions**.
The result is exported as an Excel report, with full multi-round revision history.

Here is how the running system fits together — solid lines are always present, dashed lines are optional
services you only need if you switch the matching module on (see §4):

```mermaid
flowchart LR
    User(["Curator in a browser"]) -->|HTTPS| NGINX["nginx<br/>(TLS + reverse proxy)"]
    NGINX --> APP["App container<br/>(Express API + Vue site)"]
    APP --> PG[("PostgreSQL<br/>data + job queue")]
    APP --> S3[("S3 / MinIO<br/>uploaded & generated files")]
    APP -.->|optional| GEM["Google Gemini"]
    APP -.->|optional| SOFT["Softcite"]
    APP -.->|optional| GRO["GROBID + OpenAlex + ORCID"]
    APP -.->|optional| MDC["Docling / MarkItDown<br/>(PDF → text)"]
    APP -.->|optional| AUTH0["Auth0 (ASAP Hub login)"]
```

**Runtime pieces you will provision:**

| Piece | What it is | Required? |
|-------|-----------|-----------|
| **Node.js backend + Vue frontend** | One Docker image (Express API that also serves the built SPA) | ✅ |
| **PostgreSQL 15+** | Primary database **and** the pg-boss job queue (same DB) | ✅ |
| **AWS S3** (or MinIO locally) | File storage (uploads, generated artifacts) | ✅ |
| **Google Gemini API key(s)** | LLM for DAS / datasets / protocols / materials detection, Generated-KRT consolidation (KRT generation), and AI suggestions (KRT comparison) | ⬜ (per module) |
| **LangExtract (Python)** | Pass-1 signal extraction for datasets detection | ⬜ (datasets only) |
| **Softcite service** | Software-mention detection (external HTTP service) | ⬜ (software only) |
| **GROBID service** | Author/ORCID extraction from the PDF header | ⬜ (ORCID only) |
| **Modal/Docling or MarkItDown** | PDF→Markdown conversion | ⬜ (text detectors) |
| **Auth0 tenant** | ASAP Hub login (OAuth2/OIDC + ROPG) | ⬜ (optional 2nd login) |

Every detection module is **optional and independently switchable** — see §4 and §5. With no external
keys at all, the app still runs and (by default) serves **demo data** so you can click through the workflow.

---

## 2. Prerequisites

- **Docker** + **Docker Compose** (local) or Docker on the host (production).
- **Node.js 20+** and **npm** (only if you run outside containers, e.g. for migrations/scripts on a host).
- **PostgreSQL 15+** reachable from the app.
- An **S3 bucket** (or MinIO for local).
- (Optional) **Google Gemini** API key(s); a **Softcite** endpoint; a **GROBID** endpoint; an **Auth0** tenant.
- (Optional, datasets) a **Python 3** environment with the `langextract` (and, for local PDF→MD, `markitdown`) packages.

---

## 3. Config files at a glance

| File | Tracked in git? | Purpose |
|------|-----------------|---------|
| `.env` (root) | ❌ (copy from `.env.example`) | **All backend configuration** — DB, JWT, Auth0, S3, per-module flags & API keys. See §4. |
| `src/frontend/.env` / `.env.production` | ❌ (copy from `src/frontend/.env.example`) | Frontend build/runtime: just `VITE_API_URL`. |
| `src/backend/data/prompts/*.txt` + `*.json` | ✅ tracked | **LLM prompts** for the Gemini-based detectors. Editing these changes detection behaviour without code changes. See §4.3. |
| `src/backend/data/software-list.json` | ❌ gitignored | Source data for the curated **software enrichment list**, imported at deploy time (see §6.5). |
| `src/backend/data/demo-findings/*.json` | ❌ gitignored (`.gitkeep` kept) | Per-manuscript demo detection results used when a module runs in **Demo** mode. |
| `src/frontend/public/demo-files/*` | ❌ gitignored (`.gitkeep` kept) | Real demo manuscripts/KRTs dropped in on the host for the "Use Demo Metadata" flow. |
| `conf/rate-limits.json` | ✅ tracked | API rate-limit buckets (auth, refresh, upload, LM). |
| `Dockerfile`, `docker-compose.yml` | ✅ tracked | Container build + local stack. |
| `deploy/asap-kr-sync-{dev,prod}.service` | ✅ tracked | Production systemd units (the `docker run` command). |
| `nginx/asap-kr-sync.conf` | ✅ tracked | Production reverse-proxy / TLS config. |

> **Prompts:** the detection/comparison prompts live at `src/backend/data/prompts/*.txt` and are **public and
> version-controlled** — a single canonical set, no `.txt.example` templates and no copy step. Prompts are cached
> in-process at startup — **restart the backend after editing a prompt.**

---

## 4. Backend configuration (`.env`)

Copy the template and edit:

```bash
cp .env.example .env
```

`.env.example` is fully commented; this section explains the **effect** of each group.

### 4.1 Core / server / database

| Variable | Effect |
|----------|--------|
| `NODE_ENV` | `development` or `production`. **In `production`, Winston also writes file logs** (`logs/app.log`, `logs/error.log`); otherwise logs go to stdout only. Also tightens a few startup checks. |
| `PORT` | Port the backend listens on **inside** the container (default `3000`). Leave as-is for Docker. |
| `APP_PORT` | **Host** port mapped to the container's `PORT` under docker-compose. Change this if `3000` is taken. |
| `VITE_HOST_PORT` | Host port for the Vite dev server (default `5173`). |
| `API_BASE_URL` | Public URL of the backend. Used to build the **Auth0 callback URL** (`${API_BASE_URL}/api/auth/callback`). Must match how the browser reaches the API. |
| `FRONTEND_URL` | Public URL of the frontend. **CORS allow-list** + Auth0 post-login redirect target. Must be set correctly in production or cookie auth/CORS breaks. |
| `DATABASE_URL` | Postgres connection string. **Required.** |
| `DATABASE_POOL_MIN/MAX` | Connection pool sizing. |
| `DATABASE_SSL` / `DATABASE_SSL_REJECT_UNAUTHORIZED` | Enable TLS for managed Postgres (RDS/Aurora). Set reject=false only for self-signed certs. |

### 4.2 Auth, accounts, storage, logging

| Variable | Effect |
|----------|--------|
| `JWT_SECRET` | **Signing secret for local sessions. Required; use a 32+ char random value in production.** |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Access (default `15m`) and refresh (default `7d`) token lifetimes. Short access TTL = faster propagation of role/block changes. |
| `SIGNUP_ENABLED` | `false` (default) → public `POST /api/auth/register` is rejected and the Register link is hidden. **Self-signups always get role `author`** regardless. Admin-created users and first-time Auth0 users are unaffected. |
| `AUTH0_ENABLED` | `true` turns on the ASAP Hub login tab (needs the credentials below). |
| `AUTH0_DOMAIN/AUDIENCE/CLIENT_ID/CLIENT_SECRET` | Auth0 app credentials. In EC2 these are loaded from **AWS Secrets Manager** via `AUTH0_SECRET_ID` (set in the systemd unit) and override the `.env` values. |
| `AUTH0_VERIFY_ON_REFRESH` | `true` (default) re-checks Auth0 block/delete status on each refresh (~15 min propagation; +100-300 ms/refresh). |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials. In production, prefer an **EC2 instance role** and omit the static keys. |
| `S3_BUCKET_NAME` | Target bucket. **Required.** |
| `S3_BUCKET_PREFIX` | Key prefix (`dev/`, `prod/`) — lets one bucket serve multiple environments. |
| `S3_ENDPOINT` | Set to `http://localhost:9000` for **MinIO** local dev; leave empty for real AWS S3. |
| `PYTHON_BIN` | Python 3 binary used by the **MarkItDown** converter and the **LangExtract** datasets helper. Must have those packages installed. |
| `LOG_LEVEL` | `info` (default) / `debug` / etc. `debug` surfaces verbose diagnostics (e.g. the Auth0 ID-token claim dump). |
| `LOG_FILE` | File path for the production file transport (default `logs/app.log`, relative to the container workdir `/app`). |
| `KRT_TEMPLATE_URL` | Link shown in the UI for the blank KRT spreadsheet template. |

### 4.3 Detection-module configuration — the On / Demo / Off model

**This is the most important configuration concept.** Every background module shares the same two-flag pattern:

```
<MODULE>_ENABLED=true|false              # call the real external service?
<MODULE>_DEMO_DATA_ENABLED=true|false    # fall back to demo data?
```

These produce three **config states** (shown as a pill in the UI):

| `_ENABLED` | `_DEMO_DATA_ENABLED` | State | Behaviour |
|:---:|:---:|:---:|---|
| `true` | (any) | **On** | The external service is the source of truth. Demo data is only a *final-attempt* fallback if the service errors out after all retries. |
| `false` | `true` | **Demo** | Demo data is the only source (no external calls). |
| `false` | `false` | **Off** | The module produces no data. |

Put simply, the two flags decide where a module gets its data:

```mermaid
flowchart TD
    Q{"&lt;MODULE&gt;_ENABLED = true ?"} -->|yes| ON["ON — call the real service<br/>(demo data only as a last-resort fallback)"]
    Q -->|no| Q2{"&lt;MODULE&gt;_DEMO_DATA_ENABLED = true ?"}
    Q2 -->|yes| DEMO["DEMO — use bundled demo data only"]
    Q2 -->|no| OFF["OFF — module produces no data"]
```

And one of two **outcome states** after a run:

- **Done** — the external service returned (even empty), *or* demo data was found.
- **Fail** — the external service errored after all retries **and** no demo data exists for that manuscript.

> **Key design point — fail-soft:** a misconfigured or down external service degrades only *its own* module
> (to demo/empty), never the whole submission. Demo fallback fires **only after** pg-boss retries are
> exhausted, so transient errors retry the real service first.
>
> **Defaults are deliberate:** real external services default to **disabled** (you opt in by setting `_ENABLED=true`
> and the API key); most demo paths default **on** so the app is clickable out of the box.

### 4.4 Per-module reference (engine, inputs, config)

> This table is the **configuration** view. For each module's full internal workflow (the 4-stage detector
> contract, demo fallback, outputs, and how results become the Generated KRT), see
> **[Background Modules](./background-modules.md)**.

| Module | `.env` prefix | Engine / how it works | Prompt / config file |
|--------|---------------|------------------------|----------------------|
| **PDF→Markdown** | `PDF_MARKDOWN_` | Converts the (merged) PDF to Markdown **once**, reused by the text detectors. `PDF_MARKDOWN_PROVIDER=modal` → remote **Docling** (set `..._MODAL_API_URL/_KEY`); fallback is local **MarkItDown** (Python subprocess via `PYTHON_BIN`). | — |
| **DAS Extraction** | `DAS_EXTRACTION_` | **Google Gemini** (`gemini-2.5-flash`) reads the Markdown and copies the requested section verbatim. Section chosen by `DAS_EXTRACTION_SECTION` (das, funding, consent, ethics, author_contributions, acknowledgements, coi, keywords). | `prompts/das-extraction.txt` |
| **Datasets Detection** | `DATASETS_DETECTION_` | **Two passes:** (1) **LangExtract** (Python) extracts grounded candidate mentions with source spans; (2) **Gemini** consolidates/dedupes/scores them. Tunables: `..._LANGEXTRACT_MAX_WORKERS/_MAX_CHAR_BUFFER/_EXTRACTION_PASSES/_BATCH_LENGTH/_TIMEOUT`. | Pass 1: `prompts/datasets-signals-extraction.txt` + `prompts/datasets-signals-examples.json`; Pass 2: `prompts/datasets-consolidation.txt` |
| **Materials Detection** | `MATERIALS_DETECTION_` | **Google Gemini**, **author-seeded** on the author's KRT material rows (minimal). **Skips extraction entirely when the author provided no materials.** | `prompts/materials-detection.txt` |
| **Protocols Detection** | `PROTOCOLS_DETECTION_` | **Google Gemini** reads the Markdown; **seeded with the author's protocol rows as "Section 0"**; a post-filter reclassifies purely computational "protocols" as software. | `prompts/protocols-detection.txt` |
| **Software Detection** | `SOFTCITE_API_` / `SOFTWARE_DETECTION_DEMO_DATA_ENABLED` | **Softcite** external HTTP service (a domain-trained NER model — **not** an LLM, no prompt, no token cost). Point `SOFTCITE_API_BASE_URL` at your Softcite instance. | — |
| **ORCID / Authors** | `GROBID_API_` / `OPENALEX_` / `ORCID_API_` / `ORCID_EXTRACTION_DEMO_DATA_ENABLED` | Chain: **GROBID** (parses PDF header) → **OpenAlex** (verifies ORCIDs by DOI; free, set `OPENALEX_MAILTO`) → **ORCID public API** (fallback). Writes to `submission.authors`, **not** the KRT. | — |
| **Identifier Detection** | `IDENTIFIER_DETECTION_` | **Local** scan of the Markdown against the curated `enrichment_list_entries` — no external call, no prompt. Recovers known RRIDs/DOIs/accessions the other detectors miss. Flags: `IDENTIFIER_DETECTION_ENABLED` (default on), `IDENTIFIER_DETECTION_CUT_AT_REFERENCES` (default on — truncate at the bibliography; set `false` for combined manuscript+supplemental PDFs). | uses the enrichment lists (§6.5) |
| **PDF Analysis** | `PDF_ANALYSIS_ENABLED` + `KRT_GENERATION_` | **Generated KRT builder.** Rule-based merge (alias-aware; **auto-detects SOURCE from the identifier** — allowlist-only, DOI/accession outranks URL, ambiguous → blank), then an **LM (Gemini)** consolidates the candidates. **LM-primary with a rule-based fallback:** when `KRT_GENERATION_ENABLED` is off or the LM errors, the merged candidates are the Generated KRT. | `prompts/pdf-analysis-krt.txt` |
| **AI Suggestions** | `KRT_COMPARISON_` | **Google Gemini** compares the author KRT vs the Generated KRT and emits per-resource decisions (add/skip/update/remove) with reasons. **LM-only — no fallback** (without it, no suggestions). Runs **last** (depends on PDF Analysis). | `prompts/krt-comparison.txt` |

> So: **Gemini** powers DAS, datasets (pass 2), materials, protocols, the Generated-KRT consolidation
> (KRT generation), and AI suggestions (KRT comparison). **LangExtract** is datasets pass 1 only.
> **Softcite/GROBID/OpenAlex/ORCID** are non-LLM HTTP services. **Identifier detection** is fully local, and
> **PDF analysis** falls back to a local rule-based merge when its LM is off. To enable a Gemini module you set
> `<MODULE>_ENABLED=true` **and** its `..._GEMINI_API_KEY`.

### 4.5 Module pipeline order

When a PDF is uploaded, the orchestrator runs modules as a small dependency graph (details in
[background-jobs.md](./background-jobs.md)):

```mermaid
flowchart LR
    UP(["PDF uploaded"]) --> SW["Software<br/>(Softcite)"]
    UP --> OR["ORCID / authors<br/>(GROBID+OpenAlex+ORCID)"]
    UP --> MDC["Markdown Convert<br/>(Docling / MarkItDown)"]
    MDC --> DAS["DAS extraction<br/>(Gemini)"]
    MDC --> DS["Datasets<br/>(LangExtract → Gemini)"]
    MDC --> MAT["Materials<br/>(Gemini — disabled by default)"]
    MDC --> PR["Protocols<br/>(Gemini)"]
    MDC --> ID["Identifier scan<br/>(local)"]
    KRTV{{"KRT validated?"}} -.->|gate| DS
    KRTV -.->|gate| MAT
    KRTV -.->|gate| PR
    SW --> PA["PDF Analysis<br/>(merge → LM consolidate)"]
    MAT --> PA
    DAS --> PA
    DS --> PA
    PR --> PA
    ID --> PA
    PA --> SG["AI Suggestions<br/>(Gemini — KRT comparison)"]
    OR --> SG
    SG --> SUG(["persisted suggestions"])
    PA --> GK(["Generated KRT"])
    OR --> AU(["submission.authors"])
```

- Independent modules (software, ORCID, markdown) start immediately.
- The text detectors (DAS, datasets, materials, protocols, identifier) wait for **Markdown Convert**.
- **Datasets, materials, and protocols** additionally **gate on `krt_curated`** — because they seed the LM with the
  author's KRT rows, they stay in `waiting` until the author validates the KRT (status past `step_krt`), then advance
  on their own (no manual action, unlike the DAS `pending_input` gate).
- **PDF Analysis** waits for all detectors, then builds the Generated KRT (rule-based merge → LM consolidation).
  It auto-advances only if a DAS was detected; otherwise it parks in `pending_input` for the curator to supply
  the statement.
- **AI Suggestions** runs **last** — it depends on PDF Analysis (which already gates on every KRT detector). It is
  LM-only, so with no LM configured no suggestions are produced.

---

## 5. Frontend configuration

`src/frontend/.env` (dev) / `.env.production` (prod build) — a single variable:

```bash
# dev
VITE_API_URL=http://localhost:3000
# prod
VITE_API_URL=https://api.krsync.yourdomain.com
```

In dev, Vite proxies `/api` to this URL; in the production build it's the API origin the SPA calls. In the
standard production deployment the **same Node process serves both the API and the built SPA**, so this is the
public site origin.

---

## 6. Database

### 6.1 Engine & schema management

PostgreSQL + Sequelize. **All schema changes are migrations** (`migrations/`), run by the Sequelize CLI. Two
seeders (`seeders/`) load the controlled vocabularies and demo data. The `scripts/init-db.js` wrapper can
create / reset / migrate / seed. UUID primary keys throughout; deletes cascade from `submissions`; no
soft-deletes (history lives in the append-only change log).

### 6.2 Data model (current tables)

Full ERD/columns: [database.md](./database.md). The 17 tables:

| Table | Purpose |
|-------|---------|
| `users` | Accounts (email, bcrypt hash and/or `auth0_sub`, `role`). |
| `teams` | Team catalog (UUID id, unique `code` VARCHAR(10), name, active). |
| `user_teams` | Many-to-many join: which users belong to which team codes. |
| `submissions` | Central manuscript record; step-based `status`, `current_round`, `authors` (JSONB). |
| `files` | Uploaded/generated artifacts (`s3_key`, type, version, round); immutable. |
| `krt_data` | KRT rows; per-round, self-referential (`origin_row_id`) for round copy-forward. |
| `validation_results` | Per-row KRT validation issues (insert-only). |
| `change_logs` | Append-only audit trail (action × source × round). |
| `reports` | Generated report records per round (insert-only). |
| `submission_jobs` | One row per background job (type, status, JSONB `result`/`logs`, pg-boss link). |
| `user_hidden_submissions` | Per-user dashboard visibility prefs. |
| `resource_types` | Controlled vocabulary of KRT resource types (drives KRT validation). |
| `app_config` | Key/value JSONB runtime config (e.g. `validation_rules`). |
| `enrichment_list_entries` | Curated reference lists for all 4 detection categories (the data behind enrichment + identifier scan). |
| `refresh_tokens` | Hashed, rotating refresh-token chain (reuse detection). |
| `rejected_resources` | Persisted record of AI suggestions the curator declined (so they don't reappear). |
| *(pg-boss schema)* | pg-boss creates its own `pgboss.*` queue tables in the same DB. |

### 6.3–6.5 First-run data loading — see §7 step 4 and below.

---

## 7. Deploy from zero

Whichever path you take, the big-picture sequence is the same — only *how* each step is run differs:

```mermaid
flowchart TD
    A["Provision infra<br/>(PostgreSQL + S3/MinIO)"] --> B["Configure .env"]
    B --> C["Build or pull the app image"]
    C --> D["Run migrations<br/>(create the schema)"]
    D --> E["Seed config<br/>(resource types + validation rules)"]
    E --> F["Create the first admin user"]
    F --> G["Import the enrichment lists"]
    G --> H["Configure Auth0<br/>(optional)"]
    H --> I["Start the app<br/>(+ nginx in production)"]
    I --> J["Verify /health and click through"]
```

### Path A — Local / single host (Docker Compose)

The compose file ships these services (selected via **profiles**):

- *(default, no profile)* `minio` + `minio-init` — S3-compatible storage + bucket creation.
- `--profile with-postgres` → `postgres` (Postgres 15).
- `--profile localhost` → `app` (runs `npm run dev`: backend + Vite).
- `--profile with-markitdown` → `markitdown` (local PDF→MD converter).

**Steps:**

```bash
# 1. Clone + install (only needed if running migrations/scripts on the host)
git clone <repo> && cd asap-kr-sync
npm install

# 2. Configure
cp .env.example .env
#   Minimum edits for local:
#     S3_ENDPOINT=http://localhost:9000      (use MinIO)
#     DATABASE_URL=postgresql://postgres:postgres@localhost:5432/asap_krsync_dev
#     JWT_SECRET=<any dev value>
#   Optionally set <MODULE>_ENABLED + API keys to exercise real detectors.
cp src/frontend/.env.example src/frontend/.env

# 3. Bring up infra (MinIO + Postgres)
docker compose --profile with-postgres up -d   # minio + minio-init come up by default

# 4. Create the schema, then seed the controlled vocabulary (REQUIRED for KRT validation)
npm run migrate               # create all tables
cd src/backend && npx sequelize-cli db:seed --seed 20250101000002-seed-config.js && cd ../..

# 5. Create an admin user
node scripts/create-user.js --email=admin@example.com --password='<choose-a-strong-password>' --name="Admin" --role=admin
```

> ⚠️ **Do not use `npm run seed` / `npm run db:reset` on a fresh DB yet.** Both run `sequelize-cli db:seed:all`,
> which includes the demo-data seeder (`seeders/20250101000001-demo-data.js`) that still inserts a `team` column
> into `users` — a column that was removed (team membership now lives in `user_teams`). On Postgres that insert
> errors out. Seed the **config** seeder explicitly as shown in step 4. (Tracked as a known fix; until it lands,
> avoid the bundled demo-data seeder.)

```bash
# 6. Run the app
npm run dev                   # backend :3000 (or APP_PORT), Vite :5173
#   — or in a container:  docker compose --profile localhost --profile with-postgres up
```

> **MinIO note:** the `minio-init` container auto-creates the `asap-kr-sync` bucket. `S3_ENDPOINT` must be set
> so the AWS SDK uses path-style addressing against MinIO.
>
> **In-container Vite gotcha:** if you run the app via the `localhost` profile, the Vite dev server binds the
> container's localhost. Reach the UI at the **backend** origin (`http://localhost:${APP_PORT}`, which serves the
> built SPA), or add `server.host: true` in `vite.config.js` to expose 5173 through the port mapping.

### Path B — Production (EC2 + systemd + nginx + ECR + S3)

The production model: a single Docker image (built by CI, pushed to **ECR**) run by **systemd**, behind
**nginx** (TLS), with **PostgreSQL on the host** and files in **S3**. Full runbook: [ec2-deployment.md](./ec2-deployment.md).

**1. Build & publish the image** (CI does this automatically: push to `dev` → `dev-latest`, push to `main` →
`prod-latest`, tag `v*` → immutable tag). Manual:

```bash
docker build -t <ECR_REGISTRY>/asap-kr-sync:prod-latest .
docker push <ECR_REGISTRY>/asap-kr-sync:prod-latest
```

**2. Prepare the host directories** (the systemd unit mounts these):

```
/opt/asap-kr-sync-prod/.env                       # backend config (see §4)
/opt/asap-kr-sync-prod/credentials/               # e.g. Google service account (mounted read-only)
/opt/asap-kr-sync-prod/backend/data/              # prompts + curated data (read-only)
/opt/asap-kr-sync-prod/src/frontend/public/demo-files/
/opt/asap-kr-sync-prod/logs/                      # writable — app.log lands here
```

**3. Configure `/opt/asap-kr-sync-prod/.env`:** set `NODE_ENV=production`, `DATABASE_URL` (host Postgres via
`host.docker.internal`), a strong `JWT_SECRET`, `FRONTEND_URL`/`API_BASE_URL` (your https domain), S3 bucket
(prefer instance-role auth — omit static keys), and per-module `_ENABLED` + keys. Auth0 creds come from
**Secrets Manager** via `AUTH0_SECRET_ID` (already set in the systemd unit) — you do not put them in `.env` in prod.

**4. Install + start the service** (the unit runs `docker run … <ECR>/asap-kr-sync:prod-latest`):

```bash
sudo cp deploy/asap-kr-sync-prod.service /etc/systemd/system/
#   edit it: replace <ECR_REGISTRY>, confirm the -p 127.0.0.1:3001:3000 mapping
sudo systemctl daemon-reload
sudo systemctl enable --now asap-kr-sync-prod
sudo systemctl status asap-kr-sync-prod
```

> The unit pins the container to **loopback** (`127.0.0.1:3001:3000`) so all ingress goes through nginx.
> The container entrypoint **waits for Postgres and runs migrations automatically** on start.

**5. Reverse proxy + TLS:** install `nginx/asap-kr-sync.conf` (replace `<YOUR_DOMAIN>`), obtain a Let's Encrypt
cert (`certbot --webroot`), reload nginx. It terminates HTTPS, sets `client_max_body_size 60m`, and uses 300 s
timeouts for long PDF analysis.

**6. First-run data load** (run once against the prod DB — migrations already ran via the entrypoint):

```bash
# seed ONLY the config seeder (resource types + validation rules) — NOT db:seed:all,
# which includes the demo-data seeder that fails on a fresh DB (see the warning in Path A).
docker exec -w /app/src/backend asap-kr-sync-prod \
  npx sequelize-cli db:seed --seed 20250101000002-seed-config.js
# create the first admin
docker exec asap-kr-sync-prod node scripts/create-user.js \
  --email=admin@asap.org --password='<strong>' --name="Admin" --role=admin
```

### 6.5 / Step 7 — Import the enrichment lists

The curated reference lists (`enrichment_list_entries`) power both enrichment and the always-on identifier
scan. They are **not** seeded automatically. Load them via the **admin UI** (Admin → Enrichment Lists →
Import CSV) for each category (software, datasets, materials, protocols), or the API
(`POST /api/enrichment-list/:category/import`). The software seed data ships as the gitignored
`src/backend/data/software-list.json` (dropped onto the host); other categories are imported from curated CSVs.

### Step 8 — Configure Auth0 (optional second login method)

If `AUTH0_ENABLED=true`: in the Auth0 tenant, register **Allowed Callback URL** `${API_BASE_URL}/api/auth/callback`
and **Allowed Logout URL** `${FRONTEND_URL}/login`; enable the connections you want (Google, ORCID) and, for the
ASAP Hub email/password form, the **Password grant** (ROPG). See [auth0-integration.md](./auth0-integration.md).
First-time Auth0 users are auto-created with role `author`; an admin promotes them afterward.

---

## 8. Verify the deployment

```bash
curl -fsS http://localhost:3001/health        # prod (loopback) → expect 200
# or through nginx:
curl -fsS https://<YOUR_DOMAIN>/health
```

Then: log in as the admin → create a submission with a demo PDF/KRT → watch the job panel run the pipeline →
review suggestions → export the report. With all external modules off, demo data drives the flow.

---

## 9. Operations cheat-sheet

| Task | Command |
|------|---------|
| Tail logs (prod, file) | `tail -f /opt/asap-kr-sync-prod/logs/app.log` |
| Tail logs (stdout) | `docker logs -f asap-kr-sync-prod` / `journalctl -u asap-kr-sync-prod -af` |
| Restart | `sudo systemctl restart asap-kr-sync-prod` |
| Redeploy new image | `docker pull <ECR>/asap-kr-sync:prod-latest && sudo systemctl restart asap-kr-sync-prod` |
| Run a migration manually | `docker exec asap-kr-sync-prod npm run migrate` |
| Change a module's behaviour | edit `_ENABLED` / `_DEMO_DATA_ENABLED` / API key in `.env` → restart |
| Tune detection quality | edit the relevant `prompts/*.txt` → restart (prompts are cached at startup) |
| Enable debug logging | set `LOG_LEVEL=debug` in `.env` → restart (verbose; contains PII — revert after) |

> **Note on `journalctl` showing `[NNN blob data]`:** the console log transport colorizes output (ANSI codes),
> which journald hides by default — use `journalctl -u … -a` (and `grep -a`), or read the plain `logs/app.log`.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| App boots but UI unreachable on `:5173` | In-container Vite binds container-localhost. Use the backend origin (`:APP_PORT`) which serves the SPA, or set `server.host:true`. |
| `address already in use 0.0.0.0:5432` | A host Postgres already owns 5432. Stop it, or remap the container port. |
| A detection module always returns empty | It's **Off** or **Demo** without demo data for that manuscript, or `_ENABLED=true` but the API key/endpoint is wrong. Check the job's status pill + logs. |
| Materials detection never produces results | Expected when the author KRT has **no material rows** — the module is author-seeded and skips extraction in that case. Otherwise check it's **On** and the Gemini key is set. |
| AI Suggestions panel is empty | AI Suggestions is **LM-only** — set `KRT_COMPARISON_ENABLED=true` and `KRT_COMPARISON_GEMINI_API_KEY`. With no LM configured, no suggestions are produced. Use **Regenerate suggestions** after editing the KRT. |
| No `debug` lines despite `LOG_LEVEL=debug` | The running prod image's env-file may not set it (the `docker run` doesn't pass `LOG_LEVEL`); set it in `/opt/asap-kr-sync-prod/.env` and restart. |
| No `logs/app.log` file in prod | `NODE_ENV` isn't `production` in the env-file (file transport is prod-only). |
| CORS / cookie auth failing | `FRONTEND_URL` / `API_BASE_URL` don't match the real origins. |
| Pipeline job stuck in `waiting` | A reconciler re-drives stuck jobs every 5 min; check logs for "Pipeline reconciler". |
