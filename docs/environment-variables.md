# Environment Variables

All environment variables are documented below, organized by category. The single source of truth is `.env.example` at the repo root — this doc tracks what each variable means and the code-side defaults; if it ever drifts, trust `.env.example`.

The application loads `.env` via dotenv at startup. Cascading load order is defined in `src/backend/server.js` (look there for the precedence if you maintain multiple env files locally). For most setups one `.env` file is enough.

## Server

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Environment mode (`development` / `production`) | `development` | Yes |
| `PORT` | Backend port **inside the container** (or on bare metal). | `3000` | No |
| `APP_PORT` | **Host-side** port docker-compose binds the backend to. Override when port 3000 is taken on your machine — the container still listens on `PORT` (3000) internally. Free options: `3030`, `8080`, `8000`. Avoid `3001` (markitdown). | `3000` | No |
| `VITE_HOST_PORT` | Host-side port for the Vite dev server. | `5173` | No |
| `API_BASE_URL` | Public API URL (used to build the Auth0 callback URL). Must match `APP_PORT`. | `http://localhost:3000` | Yes |
| `FRONTEND_URL` | Frontend URL (CORS origin, Auth0 logout returnTo, post-callback redirect). Must match `VITE_HOST_PORT`. | `http://localhost:5173` | Yes |

## Database (PostgreSQL)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DATABASE_URL` | PostgreSQL connection string | — | Yes |
| `DATABASE_POOL_MIN` | Minimum connection pool size | `2` | No |
| `DATABASE_POOL_MAX` | Maximum connection pool size | `10` | No |
| `DATABASE_SSL` | Enable SSL for the database connection. Set to `true` for managed Postgres (RDS, Aurora). | `false` | No |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | When SSL is on, verify the server certificate. Set to `false` only for self-signed managed-DB providers. | `true` | No |

## Authentication (JWT)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `JWT_SECRET` | Secret key for signing local JWT tokens | — | Yes |
| `JWT_EXPIRES_IN` | Access-token lifetime. Short by design — the SPA silent-refreshes on 401. Shortening this also tightens the window before Auth0 block actions propagate. | `1h` (in `.env.example`); code falls back to `15m` if unset | No |
| `JWT_REFRESH_EXPIRES_IN` | Refresh-token lifetime — also the cookie max-age for `asap_kr_refresh`. | `7d` | No |

Since Phase 6 the local JWT pair is delivered via `HttpOnly; Secure; SameSite=Strict` cookies, never in the response body or URL hash. The frontend never sees the raw tokens. See `docs/auth0-integration.md` for the cookie layout.

## Account creation

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SIGNUP_ENABLED` | Public `POST /api/auth/register` gate. When `false`, accounts are created only by admins or via Auth0 first-login. | `false` | No |

## Authentication (Auth0)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AUTH0_ENABLED` | Enable Auth0-backed login (Google / ORCID / email-password) | `false` | No |
| `AUTH0_DOMAIN` | Auth0 tenant domain (e.g. `asap.us.auth0.com`) | — | If `AUTH0_ENABLED=true` |
| `AUTH0_AUDIENCE` | Auth0 API audience | — | If `AUTH0_ENABLED=true` |
| `AUTH0_CLIENT_ID` | Auth0 application client ID | — | If `AUTH0_ENABLED=true` |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret | — | If `AUTH0_ENABLED=true` |
| `AUTH0_SECRET_ID` | AWS Secrets Manager secret ID. When set (production / staging EC2), the four `AUTH0_*` credentials above are loaded from Secrets Manager and override any `.env` values. | — | No |
| `AUTH0_VERIFY_ON_REFRESH` | Re-check Auth0 user status (blocked/deleted) on every token refresh so disable actions propagate within ~1h (one access-token cycle since Phase 6). Adds 100-300 ms per refresh. | `true` | No |

## AWS S3 Storage

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AWS_REGION` | AWS region | `us-east-1` | Yes |
| `AWS_ACCESS_KEY_ID` | AWS access key | — | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | — | Yes |
| `S3_BUCKET_NAME` | S3 bucket name | `asap-kr-sync` | Yes |
| `S3_BUCKET_PREFIX` | Key prefix for environment isolation | `dev/` or `prod/` | No |
| `S3_ENDPOINT` | S3-compatible endpoint override. Required for MinIO local dev (e.g. `http://localhost:9000`); leave unset for real AWS S3. | — | No |

## Python subprocesses

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PYTHON_BIN` | Python 3 binary used by the MarkItDown converter and the langextract datasets-detection helper. Must have the `markitdown` and `langextract` packages installed. | `python3` | No |

## PDF Analysis (in-app KRT consolidator)

PDF Analysis is in-app since the `pdf_analysis` module landed — it merges every detection's items into the Generated KRT and has no external API call. The `*_API_*` entries below are vestigial (kept for compatibility with older `.env` files) and unused by the code.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PDF_ANALYSIS_ENABLED` | Enable the consolidator | `true` | No |
| `PDF_ANALYSIS_DEMO_DATA_ENABLED` | Demo data fallback | `false` | No |
| `PDF_ANALYSIS_SUPPRESS_SUGGESTIONS` | Filter out AI suggestions by kind. Comma-separated `<action>[:<column>[:<state>]]` tokens — **action**: `add`/`edit`/`update`; **column**: `source`/`identifier`/`resourceName`; optional **state**: `empty`/`filled` (the user's current cell value). E.g. `update:source:filled` drops SOURCE edits only when the cell already has a value (no overwrite), still allowing an empty cell to be filled. A value **replaces** the default; use `none` to suppress nothing. The default blocks name-change suggestions and SOURCE overwrites on existing rows. | `update:resourceName,update:source:filled` | No |
| `PDF_ANALYSIS_API_BASE_URL` / `PDF_ANALYSIS_API_KEY` / `PDF_ANALYSIS_API_TIMEOUT` | Vestigial — unused by code | — | No |

## DAS Extraction (Google Gemini)

Reads the converted manuscript markdown (produced by Markdown Convert)
and asks Gemini to copy the requested section verbatim. Replaces the
previous Modal-hosted Llama fine-tune endpoint (`PDF_DAS_EXTRACTOR_*`,
removed). The DAS Extraction job now depends on Markdown Convert.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DAS_EXTRACTION_ENABLED` | Set to `false` to skip DAS extraction | `true` | No |
| `DAS_EXTRACTION_GEMINI_API_KEY` | Per-service Gemini API key | — | If enabled |
| `DAS_EXTRACTION_GEMINI_MODEL` | Gemini model | `gemini-2.5-flash` | No |
| `DAS_EXTRACTION_API_TIMEOUT` | Request timeout (ms) | `120000` | No |
| `DAS_EXTRACTION_SECTION` | Which section to extract (`das`, `funding_statement`, `patient_informed_consent_statement`, `ethics_statement`, `author_contributions`, `acknowledgements`, `coi_statement`, `keywords`) | `das` | No |
| `DAS_EXTRACTION_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |

## Softcite API (Software Detection)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SOFTCITE_API_ENABLED` | Enable software detection | `false` | No |
| `SOFTCITE_API_BASE_URL` | Softcite API endpoint | `http://localhost:8050` | If enabled |
| `SOFTCITE_API_TIMEOUT` | Request timeout (ms) | `600000` | No |
| `SOFTWARE_DETECTION_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |

## PDF-to-Markdown Conversion

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PDF_MARKDOWN_PROVIDER` | Conversion provider — `modal` or `markitdown` | `modal` | No |
| `PDF_MARKDOWN_MARKITDOWN_URL` | MarkItDown service URL | `http://markitdown:3001` | If provider=markitdown |
| `PDF_MARKDOWN_MARKITDOWN_ENDPOINT` | MarkItDown endpoint path | `/convert` | No |
| `PDF_MARKDOWN_MODAL_API_URL` | Modal endpoint URL | — | If provider=modal |
| `PDF_MARKDOWN_MODAL_API_KEY` | Modal API key | — | If provider=modal |
| `PDF_MARKDOWN_MODAL_CONVERTER` | Modal converter name | `docling` | No |
| `PDF_MARKDOWN_TIMEOUT` | Request timeout (ms) | `120000` | No |
| `PDF_MARKDOWN_ENABLED` | Enable markdown conversion | `false` | No |
| `PDF_MARKDOWN_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |

## Datasets Detection (Google Gemini + langextract)

Datasets is the only detection that uses the langextract two-pass pipeline. Materials and Protocols hit Gemini directly without langextract.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DATASETS_DETECTION_ENABLED` | Enable datasets detection | `false` | No |
| `DATASETS_DETECTION_GEMINI_API_KEY` | Google Gemini API key | — | If enabled |
| `DATASETS_DETECTION_GEMINI_MODEL` | Gemini model name | `gemini-2.5-flash` | No |
| `DATASETS_DETECTION_API_TIMEOUT` | Gemini request timeout (ms) | `300000` | No |
| `DATASETS_DETECTION_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |
| `DATASETS_LANGEXTRACT_MAX_WORKERS` | Parallel processing threads in the langextract pass | `60` | No |
| `DATASETS_LANGEXTRACT_MAX_CHAR_BUFFER` | Character context per chunk | `3000` | No |
| `DATASETS_LANGEXTRACT_EXTRACTION_PASSES` | Sequential extraction passes | `1` | No |
| `DATASETS_LANGEXTRACT_TIMEOUT` | Script timeout (ms) | `600000` | No |
| `DATASETS_LANGEXTRACT_BATCH_LENGTH` | Items the langextract helper batches per Gemini call | `60` | No |

## Materials Detection (Google Gemini)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MATERIALS_DETECTION_ENABLED` | Enable materials detection | `false` | No |
| `MATERIALS_DETECTION_GEMINI_API_KEY` | Google Gemini API key | — | If enabled |
| `MATERIALS_DETECTION_GEMINI_MODEL` | Gemini model name | `gemini-2.5-flash` | No |
| `MATERIALS_DETECTION_API_TIMEOUT` | Request timeout (ms) | `300000` | No |
| `MATERIALS_DETECTION_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |

## Protocols Detection (Google Gemini)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PROTOCOLS_DETECTION_ENABLED` | Enable protocols detection | `false` | No |
| `PROTOCOLS_DETECTION_GEMINI_API_KEY` | Google Gemini API key | — | If enabled |
| `PROTOCOLS_DETECTION_GEMINI_MODEL` | Gemini model name | `gemini-2.5-flash` | No |
| `PROTOCOLS_DETECTION_API_TIMEOUT` | Request timeout (ms) | `300000` | No |
| `PROTOCOLS_DETECTION_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |

## GROBID API (ORCID Extraction)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GROBID_API_ENABLED` | Enable GROBID header extraction | `false` | No |
| `GROBID_API_BASE_URL` | GROBID API endpoint | `http://localhost:8070` | If enabled |
| `GROBID_API_TIMEOUT` | Request timeout (ms) | `30000` | No |
| `ORCID_EXTRACTION_DEMO_DATA_ENABLED` | Demo data fallback | `false` | No |

## OpenAlex API (ORCID Enrichment)

Free API — no key required. Providing a `mailto` gets access to the polite pool (higher rate limits).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OPENALEX_API_ENABLED` | Enable OpenAlex lookups | `true` | No |
| `OPENALEX_MAILTO` | Contact email for polite pool | — | No |
| `OPENALEX_API_TIMEOUT` | Request timeout (ms) | `10000` | No |

## ORCID Public API (Optional Fallback)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ORCID_API_ENABLED` | Enable ORCID name search | `true` | No |
| `ORCID_API_TIMEOUT` | Request timeout per search (ms) | `5000` | No |

## Identifier Detection (local scan — no external API)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `IDENTIFIER_DETECTION_ENABLED` | Enable the module. Set to `false` to skip identifier detection (job produces no data). | `true` | No |
| `IDENTIFIER_DETECTION_CUT_AT_REFERENCES` | Truncate the document at the first "References"/"Bibliography" heading before scanning (avoids bibliography false positives). Set to `false` to scan the whole document — needed for combined manuscript+supplemental PDFs where the Key Resources table sits after the references heading. | `true` | No |

## Logging

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LOG_LEVEL` | Winston log level (`error`, `warn`, `info`, `http`, `debug`) | `info` | No |
| `LOG_FILE` | Log file path | `logs/app.log` | No |

## KRT

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `KRT_TEMPLATE_URL` | Google Sheets KRT template URL surfaced as a download link in the SPA | — | No |

---

## Removed in Phase 5 (cleanup)

The following variables were previously documented but are not referenced anywhere in the codebase. They were removed from `.env.example` during the audit cleanup:

- `EMAIL_SERVICE`, `EMAIL_API_KEY`, `EMAIL_FROM` — no email service is currently implemented.
- `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `GOOGLE_DRIVE_FOLDER_ID` — no Google Sheets exporter is currently implemented (Excel is the only active report format).
- `MATERIALS_LANGEXTRACT_*`, `PROTOCOLS_LANGEXTRACT_*` — only datasets detection uses the langextract pipeline.

If any of these features land in the future, document the new vars here and add them back to `.env.example` in the same PR.
