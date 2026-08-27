# KRT Validation Rules

Complete reference of what triggers an **error**, a **warning**, or is **silently accepted** when the app
validates a Key Resources Table (KRT).

## The three outcomes

- **Error** (blocking) — flagged red. See [How errors gate the workflow](#how-errors-gate-the-workflow) below —
  only RESOURCE TYPE errors hard-block "Continue".
- **Warning** (advisory) — flagged yellow; the user can always proceed.
- **Silent** — accepted, nothing shown.

Only **five** columns are validated. **ADDITIONAL INFORMATION is never validated** — it never raises an error or
warning; it is only *read* to help auto-fill an empty Identifier.

## Where it is implemented

| Concern | File |
|---|---|
| Field validators (the rules below) | `src/backend/services/krt/validator.service.js` |
| Identifier detection (DOI, RRID, catalog, …) | `src/backend/services/krt/identifier-extractor.js` |
| Import-time parsing / normalization | `src/backend/services/krt/parser.service.js` |
| Cell-edit hints in the UI | `src/frontend/src/components/krt/KRTCellEditModal.vue` |

Every row runs through `validateRow` (submission flow) or `validateRowValues` (the stateless
["Validate a KRT" page](./submission-workflow.md)), which call the five field validators plus the protocols.io
cross-field check.

---

## RESOURCE TYPE

| Situation | Outcome |
|---|---|
| Empty / whitespace | **Error** — "Resource type is required" |
| N/A value | **Error** — "…(N/A is not allowed)" |
| Exact canonical type | Silent |
| Wrong casing (e.g. `antibody`) | **Error**, one-click fixable ("Use 'Antibody'") |
| Recognized synonym / plural (e.g. `Chemicals`, `Tools`) | **Error**, one-click fixable |
| Unrecognized value | **Error** — "Did you mean…?" / valid-types list |

## RESOURCE NAME

| Situation | Outcome |
|---|---|
| Empty / whitespace | **Error** — "Resource name is required" |
| N/A value | **Error** — "…not allowed as a resource name" |
| Longer than 500 characters | **Warning** — suggests shortening |
| Any other non-empty value | Silent |

## SOURCE

| Situation | Outcome |
|---|---|
| Empty **and** Software/code type **and** the row already has a real identifier | Silent |
| Empty otherwise | **Error** — "Source is required" (Source is the repository/vendor name, e.g. Zenodo, GitHub, Addgene, ATCC — the DOI/URL belongs in the Identifier column) |
| Any non-empty value | Silent |

## IDENTIFIER

**Accepted "no identifier" wording → Silent:** `Identifier pending`, `No identifier exists`, `No RRID available`,
`No RRID`.

| Situation | Outcome |
|---|---|
| N/A value, row is Optional | Silent |
| N/A value, otherwise | **Error** — "…not allowed as an identifier" |
| Empty, but a recognized identifier (allowed for the type) sits in Additional Information | Silent — auto-copied into Identifier |
| Empty, Additional Info has something but not auto-copyable | **Warning** — "…found in Additional Information" |
| Empty, row is Optional | Silent |
| Empty, otherwise | **Error** — "Identifier is required" |
| Non-empty, a recognized kind **accepted for this type** | Silent |
| Non-empty, nothing recognized, but Chemical + compact catalog code | Silent |
| Non-empty, nothing recognized at all | **Warning** — "not recognized by the app" |
| Non-empty, recognized but **not typical for this type** | **Warning** — "…not a typical identifier for…" |
| Non-empty, bare repository accession (`PXD`, `GSE`, …) | **Warning** — "not accepted on its own" (advise DOI/URL) |

### Which identifier kinds are accepted for which resource type

| Kind | Accepted for |
|---|---|
| DOI, URL | **all** types |
| RRID | Antibody, Bacterial strain, Viral vector, Chemical, Critical commercial assay, Cell line, Organism/strain, Recombinant DNA, Software/code, Other |
| SCR code | Software/code, Other |
| CAS number | Chemical |
| Cellosaurus | Cell line |
| Addgene | Recombinant DNA |
| EMDB / PDB / EMPIAR | Dataset |
| GenBank | Dataset, Oligonucleotide |
| UniProt | Dataset, Chemical |
| BioStudies accession | Dataset, Biological sample |
| PMID | Protocol |
| Catalog number (≥4-digit codes) | Antibody, Bacterial strain, Viral vector, Biological sample, Chemical, Critical commercial assay, Cell line, Organism/strain, Recombinant DNA, Other |
| Oligonucleotide sequence | Oligonucleotide |
| Repository accession (`PXD`, `GSE`, …) | **none** — always advisory; share the DOI/URL of the record |

The per-type lists live in `IDENTIFIER_KIND_ALLOWED_TYPES` (`validator.service.js`) and are safe to tune without
changing the validator structure.

## NEW/REUSE

| Situation | Outcome |
|---|---|
| Empty / whitespace | **Error** — "NEW/REUSE is required" |
| N/A value | **Error** — "…not allowed" |
| Not `new` / `reuse` | **Error** — "Invalid value" |
| `new` / `reuse` (any casing) | Silent |

## Cross-field: protocols.io

| Situation | Outcome |
|---|---|
| SOURCE contains `protocols.io` **and** IDENTIFIER is a concrete value that is **not** a DOI or URL | **Error** — "protocols.io protocols require a DOI or URL identifier" |
| SOURCE contains `protocols.io`, IDENTIFIER empty or an accepted escape-hatch phrase | Left to the standard Identifier rules (no double-flag) |

## N/A variants (rejected across fields)

`n/a`, `na`, `n.a.`, `n.a`, `not available`, `not applicable`, `none`, `-`, `--`.

---

## Import-time normalizations (before validation)

Some author inputs are silently corrected on import rather than flagged (`parser.service.js`):

| Behavior |
|---|
| "Header" rows (a resource-type name with no other data) are dropped |
| `Software` / `Code` → canonical `Software/code` |
| Software rows with blank NEW/REUSE default to `reuse` |
| Empty Identifier auto-filled from Additional Information when it holds a recognized value |
| In the cell editor, typing `None` / `n/a` into Identifier is rewritten to `No identifier exists` on save |

## How errors gate the workflow

Validation runs automatically after upload and after every edit. When the user clicks **Continue** (on Step 1 and on
the manuscript/suggestions step):

- **RESOURCE TYPE errors block** — each item must have a correct Resource Type so it can be classified for the
  analysis.
- **All other errors are non-blocking** — the user can acknowledge them and continue; they are handled downstream.
- **Warnings never block.**

See [Submission Workflow](./submission-workflow.md) for the full step-by-step gating.
