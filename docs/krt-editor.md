# KRT Editor — Complete Feature Reference

The KRT Editor (`components/krt/KRTEditor.vue`) is the table component the user works in on **Steps 1
and 2**. It is the *same component* on both, with different capabilities switched on:

| Step | View | What the user sees |
|---|---|---|
| **Step 1** — Validate KRT | `KRTView` | `KRTEditor` — the author's KRT + validation errors/warnings. No suggestions yet. |
| **Step 2** — Upload & Analyze | `PDFView` | `KRTEditor` — the KRT + **AI suggestions** from the background pipeline. |
| **Step 3** — Approve KRT | `ReviewView` | **A different, purpose-built table** (not `KRTEditor`) showing the colour-coded change diff. Covered in §5. |

> ⚠️ Step 3 is a **separate implementation**, not this component in read-only mode. Features listed
> in §1–§4 (search, quick actions, bulk operations, suggestion review) are **not** available there —
> Step 3 is review-only.

> If you only want to know what makes a cell red or yellow, see
> [KRT Validation Rules](./krt-validation-rules.md). If you want to know what the background jobs
> did to produce the suggestions, see [Background Modules](./background-modules.md).

---

## 1. Table layout & navigation

**Six columns** — RESOURCE TYPE, RESOURCE NAME, SOURCE, IDENTIFIER, NEW/REUSE, ADDITIONAL INFORMATION.

- **Resizable columns** — drag a header edge. Widths persist per browser (`localStorage`).
- **Column sorting** — click a header to toggle sort on that column.
- **Row order** — a segmented control with two options, both always visible:
  - **As submitted** — preserves the author's original row order. Ties in any sort keep insertion
    order (the sort is stable), because authors often group resources logically rather than
    alphabetically and reshuffling that is destructive.
  - **By resource type** — groups by resource-type sort order from the DB.
- **Filter tabs** — one tab per resource-type group (All / Datasets / Software–code / Protocols /
  Key Lab Materials), each with a count. A tab containing validation errors is marked. Tabs filter
  by **resource type**; they do not change sorting (the row-order control does that).
- **Search box** — case-insensitive substring filter; a row matches if **any** of the six columns
  contains the query. Has a clear button, and is cleared automatically when jumping to a row that the
  filter would have hidden.
- **Jump-to shortcuts** in the summary bar — click the error / warning / suggestion counters to
  scroll straight to the first error, first warning, or first suggestion.

## 2. Editing rows

- **Click any cell to edit.** Editing opens inline, or in the **cell edit modal**
  (`KRTCellEditModal.vue`) which also shows that cell's validation issues and any AI suggestion for it.
- **Add row** — an inline "new row" form with per-column inputs.
- **Delete row** — per-row delete button.
- **Merge rows** — select ≥2 rows → "Merge…" → a modal lets you pick which value to keep for each
  column → one merged row replaces them (`POST /api/submissions/:id/krt/merge`).
- **Inline shortcut dropdowns** — quick-pick values for RESOURCE TYPE and NEW/REUSE, so common
  values do not need typing.
- **Quick actions on empty cells** — when IDENTIFIER or SOURCE is empty, a quick-change control offers
  the accepted escape-hatch phrases directly:
  - IDENTIFIER → `No identifier exists` or `Identifier pending`
  - SOURCE → `None` (no URL to share)

  These exist because those exact phrases are what the validator accepts instead of a real
  identifier — see [KRT Validation Rules](./krt-validation-rules.md).

## 3. Validation feedback

Validation runs automatically after upload and after every edit; a manual **Re-validate KRT** button
is also available.

- **Cell-level** — the offending cell is highlighted; hovering shows the message and its suggestion.
- **Row-level** — rows carry an issue icon summarising which columns have errors vs warnings.
- **Severity colours** — red = error, yellow = warning.
- **Summary counters** — total errors / warnings / suggestions, each clickable to jump to the first one.

### Quick Fixes panel (Step 1, `KRTView`)

A carousel above the table, collapsible (the preference is remembered per browser). It offers two
kinds of batch fix:

- **Auto fixes** — any validation issue whose suggestion is of the form `Use "X"`. In practice this
  is **RESOURCE TYPE only**: case corrections (`antibody` → `Antibody`) and synonym normalisation
  (`protocols` → `Protocol`). Applies to every affected row at once ("Fix all" when several groups
  exist).
- **Manual batch fixes** — invalid RESOURCE TYPE values with no auto-suggestion, grouped when **2 or
  more** rows share the same bad value. The user picks the correct value once and it applies to all.

Everything else the validator reports is **advisory text only** — it explains what to do but has no
apply button (e.g. "Move the identifier into the IDENTIFIER column", "protocols.io protocols require
a DOI or URL identifier").

> ⚠️ **One validator rule writes to the row by itself.** When IDENTIFIER is empty and ADDITIONAL
> INFORMATION contains a value of a kind allowed for that resource type, the value is **silently
> moved into IDENTIFIER** and saved (`validator.service.js`). This is the only automatic write on the
> author side; it exists because authors routinely paste RRIDs, DOIs and oligo sequences into the
> notes column. Documented in [KRT Validation Rules](./krt-validation-rules.md).

## 4. AI suggestions (Step 2, `PDFView`)

Suggestions come from the `suggestion_generation` job — a Gemini comparison of the author KRT against
the Generated KRT. See [Background Modules](./background-modules.md) for how the Generated KRT is built.

### Suggestion types

| Type | Appearance |
|---|---|
| **Cell update** | The affected cell is marked; hovering shows the proposed value |
| **Add row** | A proposed new row rendered in the table with accept / reject controls |
| **Delete row** | The existing row is marked "AI suggests deleting this row" with accept / reject |

### Badges on a suggestion

- **In KRT** — the resource already exists in the KRT (matched row named in the tooltip); accept is
  hidden because there is nothing to add.
- **Update** — matches an existing row, so accepting updates that row rather than adding a new one.
- **Verify** — tier `needs_verification`: the detection carries **no identifier**, so it is surfaced
  but flagged for the user to confirm before adding. The tooltip carries the reason.
- **Contributing sources** — which detection modules contributed to this suggestion (derived from
  `mergedFrom`). A resource found by several detectors lists each one.

### Acting on suggestions

- **Accept** — applies the change to the KRT.
- **Edit before accepting** — the proposed values in an add-row suggestion are editable in place;
  only the fields you actually changed are sent as edits.
- **Reject** — opens a modal where an optional **free-text reason** can be recorded.
- Every suggestion must be accepted or rejected before Step 2 can be completed — leftover
  suggestions block "Continue".

### Bulk operations

Select suggestions or rows via checkboxes (including **select all visible**), then:

| Action | Notes |
|---|---|
| **Approve selected** | Asks for confirmation at **5 or more** selected suggestions |
| **Approve with Resource Type…** | Bulk-approve while overriding the resource type in one go |
| **Reject selected** | Bulk reject |
| **Edit column…** | Set one column to the same value across all selected rows |
| **Merge…** | Available when ≥2 **rows** are selected |
| **Delete selected** | Bulk row delete |

## 5. Change visualisation (Step 3, `ReviewView`)

**A separate table component**, not `KRTEditor`. Review-only — no editing, no search, no bulk actions:

- **Green rows** — newly added · **Blue rows** — updated cells · **Red rows** — deleted
- **Source tags** on each change — `AI` (accepted AI suggestion), `Val` (validation), `User` (manual edit)
- **"Show changes" toggle** — ON shows the colour-coded diff, OFF shows the final data only
- **Clickable legend** — click the `AI` / `Val` / `User` legend entries to **hide or show changes from
  that source**, so you can isolate e.g. only what the AI changed
- **Filter tabs** — by resource type, as elsewhere
- **Change history** — click any changed cell for the original value (struck through), the final
  value, and the full history with source badge, user and timestamp
- **Change statistics card** — cells updated / rows added / rows removed, split by origin

## 6. Export

**Download KRT** — a toolbar dropdown exporting the current table as **CSV** or **XLSX**.

## 6b. Regenerating suggestions

Suggestions are **persisted**, not recomputed on the fly — they do not silently change as the KRT is
edited. A **Regenerate suggestions** action (Step 2) re-runs the comparison against the current KRT
and replaces the set.

## 7. Role-gated features

- **QC / Optional flags** — the two boolean flags ("Mark as QC dataset", "Mark as Optional") are
  visible and editable **only** for `admin` and `ds_annotator`. Authors and `asap_pm` never see them.

See [Roles & Permissions](./roles-and-permissions.md) for the full matrix.

---

## What the editor does *not* do

Worth stating explicitly, because the background pipeline does all of these and the editor does not:

- It does **not** infer a SOURCE from an identifier. Typing a Nature Protocols DOI into a row with an
  empty SOURCE leaves SOURCE empty.
- It does **not** deduplicate or merge rows automatically — merging is a manual, user-driven action.
- It does **not** consult the curated enrichment lists.
- It does **not** normalise identifiers, strip software versions, or canonicalise resource-type
  spelling beyond the Quick-Fix suggestions above.

All of that happens in the background pipeline and reaches the user only as a *suggestion* they must
accept. The single exception is the Additional Information → Identifier auto-copy described in §3.

See [Background Modules — automatic transformations](./background-modules.md#21b-automatic-transformations-applied-by-the-pipeline)
for the full list of what the pipeline does silently.

---

## Key files

| Concern | File |
|---|---|
| The editor itself | `src/frontend/src/components/krt/KRTEditor.vue` |
| Cell edit modal | `src/frontend/src/components/krt/KRTCellEditModal.vue` |
| Step 1 host + Quick Fixes panel | `src/frontend/src/views/submissions/KRTView.vue` |
| Step 2 host (suggestions) | `src/frontend/src/views/submissions/PDFView.vue` |
| Step 3 change view (own table, **not** `KRTEditor`) | `src/frontend/src/views/submissions/ReviewView.vue` |
| Validation rules | `src/backend/services/krt/validator.service.js` |
| Suggestion generation | `src/backend/services/suggestion/kr-comparison.service.js` |
