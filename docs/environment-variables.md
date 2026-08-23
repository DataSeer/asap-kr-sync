# Environment Variables

Every variable the application reads, what it means, and the default it falls
back to. **This is the complete reference.**

`.env.example` is deliberately *not* complete: it holds only the decisions a
deployment has to make, so that a value copied out of it is one somebody meant
to set. Anything absent from that file and present here has a default in code —
which means setting it here PINS it, and a default improved later will not
reach that deployment.

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
| `JWT_EXPIRES_IN` | Access-token lifetime. Short by design — the SPA silent-refreshes on 401. Shortening this also tightens the window before Auth0 block actions propagate. | `15m` (in `.env.example` and in code) | No |
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
| `AUTH0_VERIFY_ON_REFRESH` | Re-check Auth0 user status (blocked/deleted) on every token refresh so disable actions propagate within ~15 min (one access-token cycle, matching `JWT_EXPIRES_IN`). Adds 100-300 ms per refresh. | `true` | No |
| `AUTH0_DEBUG_CLAIMS` | When `true`, logs verified Auth0 ID-token claim **names + values with PII masked** (email/name/sub/etc. redacted; custom/namespaced claims like a role claim shown in full). Use to discover which claim carries the role and its shape. Safe to enable temporarily in any env; keep off in normal operation. | `false` | No |

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

## PDF Analysis (Generated KRT — LM-primary, rule-based fallback)

PDF Analysis regroups + coarse-dedups every detection's items (preserving per-resource `detectedBy` provenance), then asks an **LM (Google Gemini)** to consolidate those candidates into the final Generated KRT (merging near-duplicates, dropping non-resources, cleaning fields, attaching a `reason` per kept line). It is **LM-primary with a rule-based fallback** — when `KRT_GENERATION_ENABLED` is off or the LM errors, it falls back to the rule-based merge so the pipeline always yields a Generated KRT. It calls no service of its own — the LM step goes through [KRT Generation](#krt-generation-google-gemini--generated-krt), so that is where the model and key are configured.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PDF_ANALYSIS_ENABLED` | Enable the consolidator | `true` | No |
| `PDF_ANALYSIS_DEMO_DATA_ENABLED` | Demo data fallback | `false` | No |
| `PDF_ANALYSIS_API_TIMEOUT` | How long the consolidation job may run before pg-boss expires it and re-delivers (ms). Named for the external API this step used to call; it now sizes the JOB, and the name is kept because changing it would break every existing `.env` | `300000` | No |
| `PDF_ANALYSIS_SUPPRESS_SUGGESTIONS` | Filter out AI suggestions by kind. Comma-separated `<action>[:<column>[:<state>]]` tokens — **action**: `add`/`edit`/`update`; **column**: `source`/`identifier`/`resourceName`; optional **state**: `empty`/`filled` (the user's current cell value). E.g. `update:source:filled` drops SOURCE edits only when the cell already has a value (no overwrite), still allowing an empty cell to be filled. A value **replaces** the default; use `none` to suppress nothing. The default blocks name-change suggestions and SOURCE overwrites on existing rows. | `update:resourceName,update:source:filled` | No |

## KRT Generation (Google Gemini — Generated KRT)

The LM that consolidates the merged detection candidates into the final Generated KRT (PDF Analysis). When **off**, PDF Analysis uses the rule-based merge fallback (the merged candidates) instead.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `KRT_GENERATION_ENABLED` | Enable the LM consolidation step. When `false`, PDF Analysis uses the rule-based merge fallback. | `false` | No |
| `KRT_GENERATION_GEMINI_API_KEY` | Google Gemini API key | — | If enabled |
| `KRT_GENERATION_GEMINI_MODEL` | Gemini model name | `gemini-2.5-flash` | No |
| `KRT_GENERATION_API_TIMEOUT` | Request timeout (ms) | `300000` | No |

## KRT Comparison (Google Gemini — AI Suggestions)

The LM that powers AI Suggestions (the `suggestion_generation` job): it compares the author KRT vs the Generated KRT and emits, for every generated resource, a decision (add / skip / update / remove) with a reason, plus author-side fixes. This module is **LM-only — there is no fallback**: without these variables configured, **no AI suggestions are produced**.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `KRT_COMPARISON_ENABLED` | Enable AI Suggestions (KRT comparison). When `false`, no suggestions are generated. | `false` | No |
| `KRT_COMPARISON_GEMINI_API_KEY` | Google Gemini API key | — | If enabled |
| `KRT_COMPARISON_GEMINI_MODEL` | Gemini model name | `gemini-2.5-flash` | No |
| `KRT_COMPARISON_API_TIMEOUT` | Request timeout (ms) | `300000` | No |

## DAS Suggestions (Google Gemini — Availability Statement check)

The LM that powers the DAS Suggestions shown on the `/availability` step (the `das_suggestions` job). It checks the Data/Code Availability Statement against the ASAP rulebook (see [background-modules.md → `das_suggestions`](./background-modules.md#311-das_suggestions--availability-statement-check-das-suggestions)) and returns a per-rule verdict. **LM-only:** when disabled / no key, the frontend **falls back to the legacy in-browser rules** and Continue is not blocked.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DAS_SUGGESTIONS_ENABLED` | Enable the LM DAS check. When `false`, the frontend uses the legacy hardcoded rules. | `false` | No |
| `DAS_SUGGESTIONS_GEMINI_API_KEY` | Google Gemini API key | — | If enabled |
| `DAS_SUGGESTIONS_GEMINI_MODEL` | Gemini model name | `gemini-2.5-flash` | No |
| `DAS_SUGGESTIONS_API_TIMEOUT` | Request timeout (ms) | `120000` | No |

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
| `SOFTWARE_DETECTION_GEMINI_API_KEY` | Gemini key for the software LM pass | — | No |
| `SOFTWARE_DETECTION_GEMINI_MODEL` | Model for the LM pass | `gemini-2.5-flash` | No |
| `SOFTWARE_DETECTION_API_TIMEOUT` | Timeout for the LM pass (ms) | `300000` | No |
| `SOFTWARE_DETECTION_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |

## KRT Grounding

Judges each of the author's KRT rows against the manuscript. The deterministic
matcher always runs; the LM second look only enriches what it could not settle.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `KRT_GROUNDING_GEMINI_API_KEY` | Gemini key for the second look | — | No |
| `KRT_GROUNDING_GEMINI_MODEL` | Model for the second look | `gemini-2.5-flash` | No |
| `KRT_GROUNDING_API_TIMEOUT` | Request timeout (ms) | `180000` | No |
| `KRT_GROUNDING_SECOND_LOOK_ENABLED` | Set to `false` to skip the LM pass entirely. The deterministic matcher still runs, so the module never goes dark — it just settles fewer rows | `true` | No |

## Shared Gemini credentials

Nine modules call Gemini. Each still accepts its own `<MODULE>_GEMINI_API_KEY`
and `<MODULE>_GEMINI_MODEL`, but both now fall back to a shared value, so one
line configures the whole pipeline and a per-module override is reserved for
when you actually need a separate quota or a different model.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `GEMINI_API_KEY` | Used by any Gemini module that has no key of its own | — | For every LM module |
| `GEMINI_MODEL` | Used by any Gemini module that has no model of its own | `gemini-2.5-flash` | No |

Resolution order per module: `<MODULE>_GEMINI_API_KEY` → `GEMINI_API_KEY` → unset
(the module reports itself `off`).

## PDF-to-Markdown Conversion

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PDF_MARKDOWN_PROVIDER` | Conversion provider — `modal` (remote Docling) or `markitdown` (a **local Python subprocess**, so it needs no URL — see `PYTHON_BIN`) | `modal` | No |
| `PDF_MARKDOWN_MODAL_API_URL` | Modal endpoint URL | — | If provider=modal |
| `PDF_MARKDOWN_MODAL_API_KEY` | Modal API key | — | If provider=modal |
| `PDF_MARKDOWN_MODAL_CONVERTER` | Modal converter name | `docling` | No |
| `PDF_MARKDOWN_TIMEOUT` | Request timeout (ms) | `120000` | No |
| `PDF_MARKDOWN_ENABLED` | Enable markdown conversion | `false` | No |
| `PDF_MARKDOWN_DEMO_DATA_ENABLED` | Demo data fallback | `true` | No |
| `MARKDOWN_FILTER_ENABLED` | Drop a conversion that looks like junk rather than letting every later step read it | `false` | No |
| `MARKDOWN_FILTER_MIN_CHARS` | Above this many characters, the conversion is suspected of being a scanned or mis-parsed document | `300000` | No |
| `MARKDOWN_FILTER_LANG_RATIO` | Minimum ratio of recognisable-language characters | `0.30` | No |

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
| `DATASETS_LANGEXTRACT_TEMPERATURE` | Sampling temperature for the langextract pass. `0` for the same reason every other call uses it: this is extraction over a fixed document, so sampling variety is noise | `0` | No |
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

## Rate limits

Defaults live in `conf/rate-limits.json`. Any bucket can be overridden per
environment without a redeploy, by pattern rather than by a variable per bucket:

```
RATE_LIMIT_<BUCKET>_MAX          requests allowed in the window
RATE_LIMIT_<BUCKET>_WINDOW_MS    the window, in milliseconds
```

`<BUCKET>` is the upper-cased key from that file: `API`, `AUTH`, `REFRESH`,
`UPLOAD`, `LMAPI`.

| Bucket | What it limits |
|--------|----------------|
| `api` | the per-IP baseline across the whole `/api` surface |
| `auth` | sign-in attempts |
| `refresh` | token refreshes |
| `upload` | file uploads |
| `lmApi` | the per-user cap on triggering LM, detection and conversion jobs — the one that costs money |

Because these are read through a computed name, a search for
`process.env.RATE_LIMIT_API_MAX` finds nothing. They are live.

## Turning a module on or off

Every pipeline module follows the same two-variable pattern:

```
<MODULE>_ENABLED=true               opt-IN — a module is off unless this is exactly 'true'
<MODULE>_DEMO_DATA_ENABLED=false    answer from canned demo data when the real path is unavailable
```

A module runs only when it is **both** switched on **and** given the credentials
its service needs; either alone leaves it off. That is deliberate — an
unconfigured module costs nothing and reports itself as `off` throughout the
app, so an empty result reads as a configuration choice rather than as a finding
about the manuscript.

Demo data defaults to **on**, which suits a demo instance and not a real one: a
canned answer is indistinguishable from a real one in the report, and only the
run's own record says `source: demo`.

Two modules do not fit the pattern, and the exceptions matter:

- **Software Detection** has no single switch. Softcite
  (`SOFTCITE_API_ENABLED`) and the Gemini pass (`SOFTWARE_DETECTION_LM_ENABLED`)
  are enabled separately, and either one alone still produces a result — the run
  is then recorded as `partial`, naming the engine that was missing.
- **KRT Grounding** has no enable flag at all. Its deterministic matcher always
  runs, so the step is never off; only the optional LM second look can be
  disabled (`KRT_GROUNDING_SECOND_LOOK_ENABLED=false`), which settles fewer rows
  rather than producing nothing.

## Logging

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LOG_LEVEL` | Winston log level (`error`, `warn`, `info`, `http`, `verbose`, `debug`) | `http` | No |
| `LOG_FILE` | Log file path | `logs/app.log` | No |

## Provenance

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SOURCE_REPO_URL` | Where this deployment's code lives. The UI links a module's result to the prompt that produced it, so a reader can open exactly what was asked | the DataSeer repo | No |
| `SOURCE_BRANCH` | The branch those links point at | `main` when `NODE_ENV=production`, else `dev` | No |
| `GIT_SHA` | The commit this build came from. `SOURCE_COMMIT` is accepted as an alias. Recorded on every pipeline run as `app_version`. **Provenance only** — never read to decide whether an old run can be understood; that is `pipeline_version`'s job, and conflating the two turns every deploy into a history wipe. Without it a run records the package version alone, which cannot tell two deploys of the same version apart | package version | No |

## KRT

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `KRT_TEMPLATE_URL` | Google Sheets KRT template URL surfaced as a download link in the SPA | — | No |

---
