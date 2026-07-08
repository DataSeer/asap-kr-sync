# External API Integrations

The application integrates with several external services for PDF analysis, software detection, author extraction, and report generation. Each integration follows a consistent pattern: a config module for environment-based settings, a client service with retry logic, and a main service that orchestrates the business logic.

> This document covers the **external-service call specifics** (endpoints, auth, request/response). For how each
> background module works end-to-end (engine, the 4-stage contract, demo fallback, outputs), see
> [background-modules.md](./background-modules.md).

## PDF Analysis (Generated KRT — rule-based merge → LM consolidation)

PDF Analysis builds the Generated KRT in two stages: an **in-app** rule-based merge of every detection's items, then an **LM (Google Gemini)** consolidation of those candidates into the final Generated KRT. The LM step is **LM-primary with a rule-based fallback** — when it is off or errors, the merged candidates become the Generated KRT (the pipeline always yields one). The legacy `pdf-analysis-client.service.js` and the `PDF_ANALYSIS_API_*` env vars are vestigial and unused; the LM call is configured via the `KRT_GENERATION_*` vars below.

| Property | Value |
|----------|-------|
| **Service** | `src/backend/services/pdf-analysis/pdf-analysis.service.js` |
| **LM step** | `src/backend/services/pdf-analysis/krt-generation.service.js` (Google Gemini consolidation) |
| **Config** | `src/backend/config/krt-generation-api.js` |
| **Prompt** | `src/backend/data/prompts/pdf-analysis-krt.txt` |
| **Inputs** | The `result.data.items` arrays of the latest Software, Datasets, Materials, Protocols, and Identifier Detection jobs for the submission's current round |
| **Helpers** | `merge-detections.service.js` (the core matcher), `identifier-normalize.service.js` (DOI/RRID/PID token extraction), `dedupe-krt-items.service.js` (per-detection dedup) |
| **LM auth / model / timeout** | `KRT_GENERATION_GEMINI_API_KEY` / `KRT_GENERATION_GEMINI_MODEL` (default `gemini-2.5-flash`) / `KRT_GENERATION_API_TIMEOUT` (default 5 min) |
| **Disable LM** | `KRT_GENERATION_ENABLED=false` → rule-based merge fallback is used |
| **Disable module** | `PDF_ANALYSIS_ENABLED=false` (keeps the job from being scheduled) |

**Stage 1 (rule-based merge):** flatten every contributor's items into a uniform shape, then greedy-merge primaries using identifier-token intersection / opaque-id match / normalized-name match. `SOURCE_PRECEDENCE` gives software/datasets/protocols/materials precedence over identifier_detection when fields collide. Each merged resource records every contributing source under `detectedBy[]`.

**Stage 2 (LM consolidation):** Gemini consolidates the merged candidates into the final Generated KRT — merging near-duplicates, dropping non-resources, cleaning fields — attaching a `reason` to each kept line and recording dropped candidates with reasons. The final Generated KRT is persisted under `submission_jobs.result.data.items` for the `pdf_analysis` job and uploaded to S3 as `generated-krt.json`.

**Source auto-detection:** when a merged resource has **no** SOURCE supplied by any contributor, `mergeDetections` infers one from the identifier via `inferSourceFromIdentifier` (`identifier-normalize.service.js`). This is **allowlist-only** — it maps unambiguous repository URLs (GitHub, GitLab, Bitbucket), registered DOI prefixes (Zenodo `10.5281/zenodo.`, Dryad `10.5061/dryad.`, figshare `10.6084/m9.figshare.`, protocols.io `10.17504/protocols.io.`), and structured accessions (NCBI GEO/SRA/BioProject/BioSample, dbGaP, ArrayExpress, ProteomeXchange, EMPIAR, EMDB, Addgene) to a canonical source name. Anything not on the allowlist (journal DOIs, bare RRIDs, PDB/GenBank/UniProt) returns `null` and the SOURCE stays blank — it never guesses. On conflict, a **DOI/accession source outranks a URL source** (the registered identifier is the more authoritative pointer); two distinct DOI/accession sources, or two distinct URL hosts, also return `null`. It never overwrites a detector-supplied source, and the diff engine separately refuses to overwrite a user-filled SOURCE cell.

ORCID extraction is **not** a contributor — its output writes to `submission.authors`.

---

## Google Gemini API (AI Suggestions / KRT Comparison)

Powers the `suggestion_generation` background job. A Gemini call compares the **author KRT** against the **Generated KRT** and emits, for every generated resource, a decision (add / skip / update / remove) with a reason, plus author-side fixes. Author data is prioritized, the actionable list is kept manageable, and `remove` decisions are rare (clear mistakes only). The resulting suggestions are **persisted** on the job result. This module is **LM-only — there is no fallback**: with no LM configured, no suggestions are produced.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/krt-comparison-api.js` |
| **Service** | `src/backend/services/suggestion/kr-comparison.service.js` |
| **Prompt** | `src/backend/data/prompts/krt-comparison.txt` |
| **SDK** | `@google/genai` (Google GenAI Node.js SDK) |
| **Model** | `gemini-2.5-flash` (configurable via `KRT_COMPARISON_GEMINI_MODEL`) |
| **Auth** | API key (`KRT_COMPARISON_GEMINI_API_KEY`) |
| **Timeout** | 5 minutes (`KRT_COMPARISON_API_TIMEOUT`) |
| **Depends on** | PDF Analysis (Generated KRT), which already gates on every KRT detector; runs last in the pipeline |
| **Disable** | `KRT_COMPARISON_ENABLED=false` (no suggestions are generated) |

Each suggestion carries the real contributing detection module(s) (software/datasets/materials/protocols/identifier) as origin badges. Re-run via `POST /api/submissions/:id/suggestions/regenerate` (the "Regenerate suggestions" button) or any module restart that cascades through.

---

## DAS Extraction (Google Gemini)

Extracts the Data Availability Statement (or another section type) from the manuscript's converted markdown. Replaces the previous Modal-hosted Llama fine-tune endpoint.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/das-extraction-api.js` |
| **Client** | `src/backend/services/pdf/das-extraction.service.js` |
| **Prompt** | `src/backend/data/prompts/das-extraction.txt` (public, version-controlled) |
| **Auth** | `DAS_EXTRACTION_GEMINI_API_KEY` |
| **Model** | `DAS_EXTRACTION_GEMINI_MODEL` (default `gemini-2.5-flash`) |
| **Timeout** | 2 minutes (`DAS_EXTRACTION_API_TIMEOUT`) |
| **Disable** | `DAS_EXTRACTION_ENABLED=false` |
| **Depends on** | Markdown Convert (reads the markdown File from S3, not the PDF) |

**Request:** Gemini `generateContent` with a single text part — the prompt followed by `Section type: das` and the full manuscript markdown.

**Response:** A JSON object `{ "content": "<verbatim>", "partial_match": <bool>, "section_fragmented": <bool> }`. The service normalises the keys to camelCase (`partialMatch`, `sectionFragmented`).

**Processing:** Stores `content` as `extractedDataAvailabilityStatement` (read-only) and copies it to `dataAvailabilityStatement` (user-editable). Empty content persists as `"Not found"` so the user sees an extraction was attempted.

---

## Softcite API (Software Detection)

Detects software mentions in manuscript PDFs using the Softcite/software-mentions service.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/softcite-api.js` |
| **Client** | `src/backend/services/software/softcite-client.service.js` |
| **Endpoint** | `POST /service/annotateSoftwarePDF` |
| **Auth** | None |
| **Timeout** | 10 minutes (`SOFTCITE_API_TIMEOUT`) |
| **Retry** | 2 retries, 5s initial delay, 2× multiplier |
| **Default URL** | `http://localhost:8050` |
| **Disable** | `SOFTCITE_API_ENABLED=false` |

**Request:** Multipart/form-data with field `input` containing the PDF.

**Response:** JSON with `mentions` array containing software name, normalized name, version, URL, creator, type, confidence, and context.

---

## GROBID API (Author/ORCID Extraction)

Extracts article metadata (DOI, authors, affiliations, ORCIDs) from PDF headers using GROBID's TEI-XML output.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/grobid-api.js` |
| **Client** | `src/backend/services/orcid/grobid-client.service.js` |
| **Endpoint** | `POST /api/processHeaderDocument` |
| **Auth** | None |
| **Timeout** | 30 seconds (`GROBID_API_TIMEOUT`) |
| **Retry** | 2 retries, 2s initial delay, 2× multiplier |
| **Default URL** | `http://localhost:8070` |
| **Disable** | `GROBID_API_ENABLED=false` |

**Request:** Multipart/form-data with parameters `consolidateHeader=1` and `includeRawAffiliations=1`, followed by the `input` PDF field. Accept header: `application/xml`.

**Response:** TEI-XML parsed with `fast-xml-parser`. Extracts:
- **DOI** from `<idno type="DOI">`
- **Authors** from `<author>` elements with first/last names, ORCIDs (`<idno type="ORCID">`), and affiliations

**Important:** Form field order matters — parameters must be appended before the PDF file.

---

## OpenAlex API (ORCID Enrichment)

Free API that enriches author data with verified ORCIDs by looking up articles by DOI.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/openalex-api.js` |
| **Client** | `src/backend/services/orcid/openalex-client.service.js` |
| **Endpoint** | `GET /works/doi:{doi}` |
| **Base URL** | `https://api.openalex.org` |
| **Auth** | None (free API) |
| **Timeout** | 10 seconds (`OPENALEX_API_TIMEOUT`) |
| **Disable** | `OPENALEX_API_ENABLED=false` |

**Polite pool:** Set `OPENALEX_MAILTO` to an email address to get higher rate limits.

**Response:** Extracts `authorships` array with display names and ORCIDs (strips `https://orcid.org/` prefix).

**404 handling:** Returns empty authors list if DOI is not found (graceful degradation).

---

## ORCID Public API (Name Lookup Fallback)

Optional fallback for authors not found via GROBID or OpenAlex. Searches by name and affiliation.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/orcid-api.js` |
| **Client** | `src/backend/services/orcid/orcid-api-client.service.js` |
| **Endpoint** | `GET /search/?q=...` |
| **Base URL** | `https://pub.orcid.org/v3.0` |
| **Auth** | None (public API) |
| **Timeout** | 5 seconds (`ORCID_API_TIMEOUT`) |
| **Disable** | `ORCID_API_ENABLED=false` |

**Query format (Lucene):**
```
given-names:{firstName} AND family-name:{lastName} [AND affiliation-org-name:{affiliation}]
```

**Matching logic:**
- Returns ORCID only if exactly 1 result (confident match)
- Skips if >5 results (too ambiguous)
- Non-fatal: API failures log a warning and return null

---

## ORCID Extraction Pipeline

The `orcid.service.js` orchestrates the three ORCID-related APIs:

1. **GROBID** (always) → extracts DOI + author names + some ORCIDs from PDF header
2. **OpenAlex** (if DOI found) → enriches with verified ORCIDs, matched to GROBID authors by name similarity
3. **ORCID API** (optional, for remaining unmatched) → searches up to 10 authors by name + affiliation

**Name matching:** Normalized lowercase, first-letter of first name + exact last name match.

**Confidence levels:**
| Source | Confidence |
|--------|-----------|
| `grobid+openalex` (both agree) | `high` |
| `openalex` (only) | `high` |
| `grobid` (only) | `medium` |
| `orcid_api` (name search) | `medium` |

Results stored on `submission.authors` as JSONB.

---

## PDF-to-Markdown Conversion

Converts manuscript PDFs to Markdown text for downstream text analysis. Supports two providers.

### MarkItDown (local Python subprocess)

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/pdf-markdown-api.js` |
| **Client** | `src/backend/services/pdf/pdf-markdown-client.service.js` |
| **Mechanism** | Spawns `python3 -m markitdown <tmpfile>` as a subprocess (no HTTP call). The `PYTHON_BIN` env var picks the Python binary; the `markitdown` Python package must be installed in that interpreter. |
| **Response** | Markdown text on stdout |
| **Timeout** | 2 minutes (`PDF_MARKDOWN_TIMEOUT`) |
| **Disable** | `PDF_MARKDOWN_ENABLED=false` |

### Modal / Docling (Remote API, default)

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/pdf-markdown-api.js` |
| **Client** | `src/backend/services/pdf/pdf-markdown-client.service.js` |
| **URL** | `PDF_MARKDOWN_MODAL_API_URL` |
| **Request** | Multipart/form-data: `article` (PDF) + `data` (`{"converter":"docling"}`) |
| **Response** | `{ success: true, converter: "docling", markdown: "...", length: N }` |
| **Auth** | Bearer token (`PDF_MARKDOWN_MODAL_API_KEY`, optional) |

Select provider via `PDF_MARKDOWN_PROVIDER` (default `modal`; alternate `markitdown`).

The converted Markdown is stored as a `File` record (type: `markdown`) on S3 and used by the Datasets Detection pipeline.

---

## Datasets Detection (Two-Pass Pipeline)

Detects dataset mentions using a two-pass architecture: signal extraction via Python langextract, then consolidation via Google Gemini.

### Pass 1: Signal Extraction (langextract)

| Property | Value |
|----------|-------|
| **Client** | `src/backend/services/datasets/langextract-client.service.js` (Node) → `python3 -m langextract` subprocess |
| **Library** | `langextract` (Google, Python) |
| **Input** | Markdown text (from S3, produced by Markdown Convert job) |
| **Output** | JSON array of `DATASET_ROW` extractions with `extracted_text` and `attributes` |
| **Model** | `gemini-2.5-flash` (configurable via `DATASETS_DETECTION_GEMINI_MODEL`) |
| **Auth** | API key (`DATASETS_DETECTION_GEMINI_API_KEY`) |
| **Timeout** | 10 minutes (`DATASETS_LANGEXTRACT_TIMEOUT`) |

**Key parameters:** `max_workers` (60), `max_char_buffer` (3000), `extraction_passes` (1) — all configurable via env vars.

**Prompt file:** `src/backend/data/prompts/datasets-signals-extraction.txt`
**Examples file:** `src/backend/data/prompts/datasets-signals-examples.json`

### Pass 2: Consolidation (Google Gemini)

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/datasets-detection-api.js` |
| **Service** | `src/backend/services/datasets/datasets.service.js` |
| **SDK** | `@google/genai` (Google GenAI Node.js SDK) |
| **Model** | `gemini-2.5-flash` (configurable via `DATASETS_DETECTION_GEMINI_MODEL`) |
| **Auth** | API key (`DATASETS_DETECTION_GEMINI_API_KEY`) |
| **Timeout** | 5 minutes (`DATASETS_DETECTION_API_TIMEOUT`) |
| **Retry** | 2 retries, 60s delay (via pg-boss job retry) |
| **Disable** | `DATASETS_DETECTION_ENABLED=false` |

**Input:** Dataset names + extracted DATASET_ROW chunks + full article markdown.

**Consolidation rules:** Merges duplicate mentions, applies strict exclusion rules (no annotation tracks, statistical outputs, preprints, literature-only references), classifies KRT relevance.

**Response:** JSON object with a `resources` array. Each resource contains:
- `canonical_name`, `dataset_role` (`GENERATED`/`REUSED`/`BOTH`/`UNCLEAR`)
- `resource_type` (`DATASET`, `SEQUENCE_DATASET`, `DATABASE`, `CLINICAL_DATASET`, `OTHER`)
- `source_type` (`REPOSITORY`, `DATABASE`, `WEBSITE`, `SUPPLEMENTARY_FILES`, `UNKNOWN`)
- `repository`, `repository_is_real`, `accessions`, `dois`, `urls`, `aliases`
- `krt_relevance` (`HIGH`, `MEDIUM`, `LOW`)

**Prompt file:** `src/backend/data/prompts/datasets-consolidation.txt`

**Fallback:** When disabled or not configured, tries demo data matched by manuscript ID. If no demo data, stores `{ items: [], meta: { disabled: true } }`.

**Prompt management:** Prompts are stored as `.txt` / `.json` files in `src/backend/data/prompts/`. They are loaded once at first use and cached in memory. Restart the server to pick up prompt changes.

---

## Google Gemini API (Materials Detection)

> **Author-seeded and minimal.** Materials detection is now grounded on the author's KRT: the prompt
> (`src/backend/data/prompts/materials-detection.txt`) is seeded with the author's KRT material rows (via the
> shared `src/backend/services/krt/author-krt-seeds.service.js`). The detector **skips extraction entirely when
> the author provided no materials** — no author material rows → no Gemini call.

Detects lab material/reagent mentions in manuscript PDFs using Google Gemini. Follows the same pattern as datasets detection.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/materials-detection-api.js` |
| **Service** | `src/backend/services/materials/materials.service.js` |
| **SDK** | `@google/genai` (Google GenAI Node.js SDK) |
| **Model** | `gemini-2.5-flash` (configurable via `MATERIALS_DETECTION_GEMINI_MODEL`) |
| **Auth** | API key (`MATERIALS_DETECTION_GEMINI_API_KEY`) |
| **Timeout** | 5 minutes (`MATERIALS_DETECTION_API_TIMEOUT`) |
| **Retry** | 2 retries, 60s delay (via pg-boss job retry) |
| **Disable** | `MATERIALS_DETECTION_ENABLED=false` |

**Response:** JSON object with a `resources` array. Each resource contains:
- `canonical_name`, `material_type` (ANTIBODY, CELL_LINE, etc.), `material_role` (NEW/REUSE)
- `source`, `catalog_number`, `rrid`, `urls`, `krt_relevance`

**Prompt file:** `src/backend/data/prompts/materials-detection.txt`

**Enrichment:** _Removed._ Detected materials are no longer cross-referenced against the curated list — only the **Identifier Detection** module consults `enrichment_list_entries` now.

---

## Google Gemini API (Protocols Detection)

Detects protocol mentions in manuscript PDFs using Google Gemini. Follows the same pattern as datasets detection.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/protocols-detection-api.js` |
| **Service** | `src/backend/services/protocols/protocols.service.js` |
| **SDK** | `@google/genai` (Google GenAI Node.js SDK) |
| **Model** | `gemini-2.5-flash` (configurable via `PROTOCOLS_DETECTION_GEMINI_MODEL`) |
| **Auth** | API key (`PROTOCOLS_DETECTION_GEMINI_API_KEY`) |
| **Timeout** | 5 minutes (`PROTOCOLS_DETECTION_API_TIMEOUT`) |
| **Retry** | 2 retries, 60s delay (via pg-boss job retry) |
| **Disable** | `PROTOCOLS_DETECTION_ENABLED=false` |

**Response:** JSON object with a `resources` array. Each resource contains:
- `canonical_name`, `protocol_type` (EXPERIMENTAL, COMPUTATIONAL, etc.), `protocol_role` (NEW/REUSE)
- `source`, `doi`, `url`, `krt_relevance`

**Author-KRT seeding:** the prompt is seeded with the author's protocol rows as "Section 0" (via the shared `src/backend/services/krt/author-krt-seeds.service.js`). Recent prompt fixes: don't pull a reagent vendor as Source or a catalog#/RRID as Identifier; capture protocols.io DOIs/URLs and citations; exclude analyses; and improve new/reuse classification.

**Prompt file:** `src/backend/data/prompts/protocols-detection.txt`

**Enrichment:** _Removed._ Detected protocols are no longer cross-referenced against the curated list — only the **Identifier Detection** module consults `enrichment_list_entries` now.

---

## Google Sheets API (Report Generation) — not implemented

Reserved section: a Google Sheets exporter has been discussed as a possible
future export format, but **no implementation currently exists in the
codebase** (no `config/google-sheets.js`, no `GoogleSheetsExporter.js`,
no consumed `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_DRIVE_FOLDER_ID`
env vars). Excel is the only active export format — see the next section.

---

## Excel Report Generation

Active report format using the `xlsx` (SheetJS) library.

| Property | Value |
|----------|-------|
| **Exporter** | `src/backend/services/reports/ExcelExporter.js` |
| **Library** | `xlsx` (SheetJS) |

**Sheets generated:**
1. **Summary** — manuscript metadata, resource/change counts
2. **KRT Data** — resource table sorted by type group, then name
3. **Change History** — chronological audit trail
4. **LM Analysis** — AI findings with confidence and status

Output uploaded to S3; presigned URL generated on download.

---

## AWS S3 / S3-Compatible Storage

File storage for PDFs, KRT files, supplemental files, and reports.

| Property | Value |
|----------|-------|
| **Config** | `src/backend/config/aws.js` |
| **Service** | `src/backend/services/storage/s3.service.js` |
| **SDK** | AWS SDK v3 (`@aws-sdk/client-s3`) |
| **Region** | `AWS_REGION` (default: `us-east-1`) |
| **Bucket** | `S3_BUCKET_NAME` (default: `asap-kr-sync`) |
| **Prefix** | `S3_BUCKET_PREFIX` (`dev/` or `prod/`) |

**S3-compatible mode (MinIO):** Set `S3_ENDPOINT` (e.g., `http://localhost:9000`) to use MinIO with `forcePathStyle: true`.

**Key structure:** `{bucketPrefix}{submissionId}/{fileType}/{fileName}/{version}`

**Operations:** Upload (`PutObjectCommand`), Download (`GetObjectCommand`), Delete (`DeleteObjectCommand`), Presigned URLs (`getSignedUrl`).

---

## Retry Pattern

All external API clients follow the same retry pattern:

1. Make request with configured timeout
2. On failure, wait `retryDelay` seconds
3. Retry up to `maxRetries` times with `retryDelayMultiplier` backoff
4. Throw `ExternalServiceError` if all retries fail
