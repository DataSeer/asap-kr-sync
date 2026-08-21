# Design proposal — Run history: every processing run kept, and readable

**Status:** PROPOSED · **Created:** 2026-08-21
**Scope:** `submission_jobs` gains a history sidecar; the pipeline and module pages
become records of a *run* rather than views of the submission.
**Prerequisite:** none — additive to `feat/krt-detection-two-modes` as merged.

---

## 1. The requirement, stated precisely

1. A user can see **how many times** this round of a submission has been
   processed, per step: "run 1, run 2, run 3".
2. A user can **read any past run** — its results, its inputs, its prompt, its
   raw responses — not only the latest.
3. Nothing is overwritten. A re-run adds; it never replaces.
4. On the module page, a **run selector** (latest selected by default) swaps the
   page to that run's results.
5. The processes panel shows the **current run number** per step.
6. The module page shows each run's **metadata** — who started it, when, how
   long it took — in Technical detail, as a new **METADATA** column in first
   position.
7. **Authors see only the latest run.** Project managers, curators and
   administrators can browse history.

### 1.1 The governing principle

> **The pipeline and module pages never display live data. They display the data
> the run was given and produced.**

This is not a nicety. Live data changes after a run — the author edits the KRT,
replaces the PDF, an admin renames a resource type — and a page that mixes
per-run results with present-day inputs is a claim nobody made.

It is also a **prerequisite for the selector**, not an addition to it. If half
the page were live, selecting run 2 would render a chimera: run 2's detections
beside today's KRT. Freezing the whole page is what makes a run selector
coherent.

This covers **configuration as well as data**: a module disabled during a run
and enabled later must still read as disabled in that run's history (§6.1).

### 1.2 The audit requirement

Beyond reading past results, the record must answer **who did what, when** for
everything that touches a submission's processing:

- **every run** of every step — including runs that produced nothing;
- **every file** that entered it — the PDF, its replacements, the KRT;
- **every edit** to the KRT.

"Who" is a named person, "when" is a timestamp, and both must survive the thing
they describe being superseded. This is the difference between a system that can
be *reviewed* and one that merely *works*.

---

## 2. What is true today

**Nothing keeps history.** `requeueStep` reuses the round's row by design (that
is the rival-row fix), so a re-run overwrites `result`, `logs`, `errorMessage`,
`startedAt`/`completedAt` and `triggered_by_user_id` in place.

**S3 artefacts overwrite too.** `generateJobS3Key` keys them by the *job row id*:

```
{manuscriptId}_{submissionId}/round-{round}/jobs/{jobType}/{jobRowId}/{file}
```

Its comment explains the id is there "so a re-run cannot overwrite the previous
run's artefacts" — written when `runAllProcesses` created a **new row per run**.
Rows are reused now, so the id is stable across re-runs and the protection no
longer holds. The comment is stale; the behaviour is coherent (row and artefacts
both describe the latest run) but historyless.

**pg-boss is not a substitute.** `pgboss.job` + `pgboss.archive` hold ~8 days of
enqueue timestamps incidentally (13,780 rows on 21 Aug, oldest 13 Aug). That is
queue retention, not a product record.

**The page already half-admits the problem.** Technical detail says today:

> *"Every module freezes what it was given, and that record is the inputs file
> above. The documents beside it are shown as they are stored now, so an edit
> made after the run appears there even though the run never saw it — when the
> two disagree, the frozen record is what happened."*

That paragraph exists to apologise for the behaviour this proposal removes.

### 2.1 What already works in our favour

- **The module page is already result-driven.** `detections`, `outcomes`,
  `policy` and `dasSuggestions` all read `job.result.data.*`. Point the page at
  a different run's result and the tables, counts, evidence and Technical detail
  follow. The selector is a small frontend change.
- **Inputs are already recorded by identity, with a hash.** `runInputs.fileRef`
  stores `{ fileId, fileName, type, version, s3Key, bytes, sha256 }`.
- **Files are versioned in S3** (`name_v1.pdf`, `name_v2.pdf`). Replacing a PDF
  creates v2 and **v1 survives at its own key**. So "the document this run was
  given" resolves from the recorded `s3Key` at no extra storage cost, and the
  `sha256` lets the page prove the bytes have not changed underneath.

---

## 3. Data model

### 3.1 The invariant that must not break

`submission_jobs` **keeps exactly one row per (submission, jobType, round)**.
History goes in a separate table.

This is not a preference. `getForSubmission` keeps "the newest row per job
type"; an extra row there becomes a **rival row** that hides the pipeline's own,
and the advancement that should follow lands on the wrong one. That is the fault
that shipped a Generated KRT with 98 author rows and zero detections. Secondly,
the jobs endpoint is polled every few seconds and was deliberately changed to
stop reading superseded JSONB — history rows in that table would undo it.

### 3.2 `submission_job_runs`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `submission_job_id` | UUID FK → `submission_jobs` | `ON DELETE CASCADE` |
| `submission_id` | UUID FK → `submissions` | denormalised, so history is queryable without a join |
| `job_type` | VARCHAR(50) | denormalised, same reason |
| `round` | INTEGER | the run lives **inside** a round |
| `run_number` | INTEGER | 1-based, per (submission, job_type, round) |
| `status` | ENUM | this run's terminal status |
| `outcome_state` | VARCHAR(16) | `done` \| `partial` \| `fail` \| null |
| `outcome_source` | VARCHAR(16) | `external` \| `demo` \| null |
| `fail_reason` / `external_error` | TEXT | |
| `triggered_by_user_id` | UUID FK → `users` | `ON DELETE SET NULL` |
| `trigger_kind` | VARCHAR(16) | `manual` \| `pipeline` \| `reconciler` |
| `started_at` / `completed_at` | TIMESTAMPTZ | |
| `duration_ms` | INTEGER | stored, not derived — a purge of timestamps must not lose it |
| `retry_count` | INTEGER | pg-boss attempts **within** this run |
| `counts` | JSONB | the small summary (`total`/`unique`/`enriched`…) |
| `result` | JSONB | the full frozen result. **Nullable** — see 3.4 |
| `logs` | JSONB | this run's structured log |
| `inputs` | JSONB | the run's `fileRef`s and prompt ref, denormalised from `inputs.json` |
| `s3_prefix` | TEXT | where this run's artefacts live |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

```
UNIQUE (submission_job_id, run_number)
INDEX  (submission_id, round, job_type, run_number DESC)
INDEX  (triggered_by_user_id)
```

### 3.3 Where the result lives

`submission_jobs.result` stays as it is — the pipeline reads it (the
consolidator reads each detection's result; suggestions read the consolidator's)
and that must not change.

`submission_job_runs.result` holds the same bytes for the current run. **That
duplication is deliberate.** It buys one thing worth more than ~590 KB per
submission: the module page reads a **run**, always, with no "if latest read
here, else read there" branch. Uniform path, and the frozen principle holds even
for the latest run.

Measured today: a full 12-step run is **~590 KB** of `result` JSONB
(10 MB across 17 submissions), heaviest `krt_grounding` at 227 KB average /
575 KB max.

### 3.4 Pruning, if it is ever wanted

The schema separates the **run record** (always kept, small — number, status,
timings, who, counts) from the **run payload** (`result`, `logs`, and the S3
artefacts). Nulling a payload leaves a complete, honest history list with the
detail gone. No pruning is proposed now; the schema simply does not preclude it.

---

## 4. Run lifecycle

**A run begins when the step is enqueued**, not when a worker picks it up. That
is the moment somebody (or the pipeline) asked for it, and it is exactly where
`triggered_by_user_id` is already written:

- `runAllProcesses` — seeding a round, and the initial enqueue of ungated steps
- `tryAdvanceStep` — the atomic claim (`waiting` → `queued`)
- `advanceJob` — releasing a step parked on `pending_input`
- `requeueStep` — a manual re-run

**pg-boss retries are not new runs.** They are attempts *within* a run and belong
in `retry_count`; `markRetrying` updates the run row rather than opening a new
one.

A **failed or cancelled run still gets a record.** "This was attempted three
times and failed twice" is precisely the history an audit wants.

| Transition | Effect on the run row |
|---|---|
| enqueue | INSERT: allocate `run_number`, status `queued`, `triggered_by`, `trigger_kind` |
| `markProcessing` | UPDATE `started_at`, `retry_count` |
| `markRetrying` | UPDATE `retry_count`, `external_error` — still the same run |
| `markComplete` | UPDATE terminal status, outcome, counts, result, logs, timings |
| `markFailed` | UPDATE terminal status + error |
| `markCancelled` | UPDATE terminal status |

### 4.1 Allocating `run_number` safely

`tryAdvanceStep`'s conditional claim already guarantees exactly one caller wins
a `waiting` → `queued` transition, so allocation happens inside the winner. The
`UNIQUE (submission_job_id, run_number)` constraint is the backstop: if a second
path ever allocates concurrently, it surfaces as an error rather than as two
runs numbered 3.

### 4.2 A record for every enqueue — including runs that do nothing

**A disabled module still gets a full run record.** No inputs, no outputs, but
the same metadata as any other run: run number, who, when, how long, and the
configuration that made it a no-op.

This needs no special case, because it is already how the pipeline behaves. The
orchestrator does **not** check whether a module is enabled — it enqueues every
step. The worker runs, `runWithDemoFallback` short-circuits on the Off path, and
the job completes with:

```js
config:  { state: 'off', enabled: false, demoEnabled: false }
outcome: { state: 'done', source: null }   // source null = nothing was attempted
data:    { items: [] }
```

Since the run record is created at **enqueue** (§4) rather than when data is
produced, a disabled module's run is recorded like any other and its payload is
simply empty. The distinction the history must preserve — *"this module was off
during run 2, and switched on before run 3"* — is carried by the frozen
`config.state`, and is exactly what makes an empty result readable as a
configuration rather than as a finding about the manuscript.

The same applies to runs that **failed**, were **cancelled**, or ran on **demo
data**. Every enqueue is a run; every run is a record.

### 4.3 History must never break a run


Writing the run record is wrapped so a failure **logs and continues**. History
is an audit sidecar; a bug in it must not fail a pipeline step that otherwise
succeeded. The inverse — a run with no record — is recoverable and visible;
a pipeline that stops because its logbook failed is neither.

---

## 5. S3 layout

```
{manuscriptId}_{submissionId}/round-{round}/jobs/{jobType}/run-{n}/{file}
```

`generateJobS3Key` takes the run number instead of the job row id. Its stale
comment (§2) is rewritten to say what is now true.

**Existing artefacts are not moved.** The backfill (§9) records each existing
run's `s3_prefix` as its current `.../{jobRowId}/` path. Files stay where they
are; the run row knows where to look. Moving hundreds of objects to satisfy a
naming convention is risk with no user-visible gain.

---

## 6. What becomes frozen

| Surface | Today | Becomes |
|---|---|---|
| Detections / grounding / DAS tables | run's `result` ✓ | unchanged |
| Prompt | run's frozen copy ✓ | unchanged |
| Raw responses | run's S3 folder ✓ | unchanged, keyed by run |
| KRT / PDF file links | **latest files** | the run's recorded `fileRef`s |
| Markdown viewer | **live fetch** | the run's recorded markdown `s3Key` |
| ORCID author list | **live fetch** | stored in the run's `result` |
| Generated-KRT rows | run's `result` ✓ | unchanged |
| Module config (on/demo/off) | captured ✓, **displayed live in places** | display the run's captured config — see §6.1 |
| Resource-type vocabulary (type → tab group) | **live** | stored in the run — see §6.2 |

### 6.1 Module configuration is already frozen — it just is not always shown

A module that was **off** or on **demo data** during a run, and switched on
afterwards, must still read as off in that run's history. Otherwise the record
claims the module looked at the manuscript when it never ran.

The good news: `buildServiceSnapshot` **already stores this per run**:

```js
config:  { state: 'on' | 'demo' | 'off', enabled, demoEnabled }
outcome: { state, source, failReason, externalError }
```

So this is a **display** change, not a storage one. Concretely:

- **Processes panel** — already correct: `getConfigPill` is
  `job.configState || job.liveConfigState`, i.e. the run's captured config wins.
- **Module page** — Technical detail shows `outcome.source` ("Ran via external")
  but not the run's `config.state`. Add it, from the frozen snapshot.
- **Pipeline page** — shows no config at all today, so a step that was disabled
  during the run is indistinguishable from one that ran and found nothing. It
  should carry the run's config state.

**The one legitimate use of live config**, and the reason `liveConfigState`
exists: a step that has **never run** has no frozen config to show. There the
panel shows the current setting to explain why nothing will happen — a statement
about the *future*, not a claim about a past run. That is not a violation of the
principle; it is the absence of a run to describe.

Live configuration otherwise belongs to the working views (the submission's own
step pages), where the user is *changing* things — and even there it is frozen
into the run the moment a run starts.

### 6.2 Resource types: vocabulary frozen, palette live

Resource types are two things wearing one name, and the principle lands
differently on each:

- **The vocabulary** — which types exist, and which tab group each belongs to —
  is *data*. Rename or remove a type after a run and that run's rows land in the
  wrong tab, or none. **Freeze it with the run**: a `{ type → group, order }`
  map is a few hundred bytes.
- **The palette** — the colours drawn from those types — is *presentation*.
  Freezing it renders an old run in a superseded palette after a rebrand, which
  makes the app look broken rather than faithful. **Keep it live.**

Recorded as a decision rather than an oversight. If strict fidelity is wanted
for colour too, freezing it costs nothing extra — it rides in the same map.

### 6.3 When an input is gone

A run whose recorded `s3Key` no longer resolves shows *"this run's input is no
longer stored"* — never a broken link, and never a silent fallback to the
current file, which would reintroduce exactly the confusion this design removes.

---

## 7. Provenance beyond runs — files and KRT edits

Run history answers "who ran what, when". The audit requirement (§1.2) also
covers the two other things that change a submission: **the files** it is
processed from, and **the KRT edits** a person makes. Those are separate
ledgers, and one of them has a hole.

### 7.1 KRT edits — already audited

`change_logs` records `user_id`, `action`, `source`, `step`, `round`,
`row_id`, `column_name`, `old_value`, `new_value` and `created_at`. Every KRT
mutation goes through it, and the actions in use today are `upload`,
`edit`, `add_row`, `delete_row`, `approve_change`. Nothing to add.

### 7.2 Files — **who uploaded is not recorded**

`files` carries `id, submission_id, type, file_name, s3_key, mime_type, size,
version, round, created_at`. There is **no uploader column**.

The person is not lost entirely — `pdf.service.uploadPDF` and
`krt.service.uploadAndProcess` both write a `ChangeLog` with the `userId` inside
the same transaction as the `File` row. But that entry records only a free-text
`description`; it carries **no `file_id` and no version**. So "who replaced the
PDF with v2" can only be reconstructed by correlating timestamps between two
tables and parsing a sentence.

For a record that must state who did what, that is not good enough. Two small
additions close it:

| Change | Why |
|---|---|
| `files.uploaded_by_user_id` (UUID, FK, `ON DELETE SET NULL`) | the direct answer, on the row that is the subject of the question |
| `change_logs.file_id` (UUID, FK, nullable) | ties the narrative entry to the exact file version it describes |

Both are nullable and backfill to NULL for existing rows — provenance starts
now, and no existing behaviour changes.

### 7.3 What "frozen" then buys

Once a run records the `fileRef` it was given (§6) and the file records who put
it there, the chain is complete and answerable in one query:

> *Run 3 of KRT Grounding read `manuscript_v2.pdf`, uploaded by Marie on
> 19 August, and the table as Nicolas had edited it that morning.*

That sentence is the point of the whole design.

### 7.4 Putting a submission aside: hidden, soft-deleted, hard-deleted

Three states, three different intentions. They are **not** degrees of the same
thing, and conflating them is the way this goes wrong:

| State | What the user means | Still a "real" submission? |
|---|---|---|
| **Hidden** | *"I won't work on this again — put it aside."* | **Yes.** Counted, processed, listed under the dashboard's Hidden section. A per-user preference (`user_hidden_submissions`), not a property of the submission. |
| **Soft-deleted** | *"This was a mistake. Stop treating it as real — but I'm not an admin."* | **No.** `submissions.deleted = true`. Nothing is removed. |
| **Hard-deleted** | *"This was a mistake or a test, and I'm an admin, so I know what erasing it means."* | **Gone.** DB rows cascaded, S3 prefix cleared, work stopped instantly. |

#### Who can do what

Authorisation is **two gates in order**: `canAccessSubmission` first, then role.
Access is never implied by role — an admin who cannot access a submission cannot
delete it either.

| Action | Gate 1 | Gate 2 |
|---|---|---|
| Hide | `canAccessSubmission` | any role |
| Soft delete | `canAccessSubmission` | any role |
| Hard delete | `canAccessSubmission` | `admin` |
| Restore | `canAccessSubmission` | `admin` — see below |

This **widens** deletion: today the route is
`requireRole(ADMIN, DS_ANNOTATOR)`, so an author cannot delete even their own
submission. Recorded as a deliberate change, not a side effect.

#### Visibility

A soft-deleted submission is invisible to `author`, `asap_pm` and `ds_annotator`
— which leaves **admins as the only role that can see it**. That follows from
the intent ("the app must stop considering it real") and it has one consequence
worth stating plainly:

> **Restore is effectively admin-only.** The author who soft-deletes by mistake
> cannot see it afterwards, so they cannot undo it themselves — they must ask an
> admin.

That is defensible, but it makes soft delete feel final to the person doing it.
It therefore needs a **confirmation step that says so** ("only an administrator
can undo this"), or users will treat it as reversible and be surprised.

Everywhere else — lists, counts, filters, the reconciler, the pipeline — a
soft-deleted submission is simply absent.

#### The admin purge

Soft delete is, in practice, *queued for erasure*. Admins get a periodic sweep —
"hard-delete everything soft-deleted more than N days ago" — following the shape
the Jobs admin page already uses for stale jobs (a filter, a count, an explicit
confirm, and a re-classification at call time so a submission restored since the
page loaded is skipped).

#### Hard delete stops everything, immediately

Queued and processing work is cancelled and the queue entries dropped before the
rows go, exactly as the current delete endpoint does. A soft delete cancels the
queued work too — otherwise workers keep spending real money on a submission the
user believes is gone.

#### The deletion is itself recorded

If an administrator erases a submission, the record of the erasure must survive
the erasure. That cannot live in `change_logs`, whose `submission_id` is
`ON DELETE CASCADE` and which the hard delete destroys. It needs a retained
table holding **plain values rather than foreign keys**:

```
submission_deletions(
  id,
  submission_id,        -- a value, deliberately NOT a foreign key
  manuscript_id, title, owner_user_id,
  kind,                 -- 'soft' | 'hard' | 'restore'
  performed_by_user_id, -- FK to users, ON DELETE SET NULL
  performed_at,
  reason,               -- optional, free text
  counts                -- what was destroyed: runs, files, KRT rows, S3 objects
)
```

`counts` matters for a hard delete: after the fact it is the only remaining
statement of what was there. Without this table the most destructive action in
the system would be the least accounted for, which is the inverse of §1.2.

---

## 8. API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/submissions/:id/jobs/:jobType/runs` | run list — metadata only, newest first |
| `GET` | `/api/submissions/:id/jobs/:jobType/runs/:runNumber` | one run in full (result, inputs, logs) |

`GET /api/submissions/:id/jobs` gains `runNumber` and `runCount` per step, so
the panel needs no extra request.

**Access.** Both run endpoints sit behind `canViewJobInternals` — the existing
middleware that already blocks authors from raw responses and prompts. An author
requesting a specific run gets 403; the panel's `runCount` stays visible to
everyone, because "this has been processed 3 times" is not internal.

---

## 9. Migration and backfill

One migration:

1. create `submission_job_runs`;
2. insert **one row per existing `submission_jobs` row** — `run_number = 1`,
   copying status, outcome, counts, result, logs, timings and
   `triggered_by_user_id`, with `s3_prefix` set to the existing
   `.../jobs/{jobType}/{jobRowId}/` path;
3. add `run_count` to `submission_jobs` (denormalised, default 1) so the panel
   and the jobs list need no aggregate query;
4. add `files.uploaded_by_user_id` and `change_logs.file_id` (§7.2), both
   nullable, both backfilling to NULL — file provenance starts now rather than
   being invented retrospectively;
5. add `submissions.deleted` (boolean, default false, indexed) and
   `submissions.deleted_at` (so the admin purge can select "soft-deleted more
   than N days ago"), plus the `submission_deletions` ledger (§7.4). Existing
   submissions backfill to `false`/NULL, and the ledger starts empty — a
   deletion that happened before the ledger existed cannot be invented.

History therefore starts complete rather than empty, with every existing run
presented as run 1.

---

## 10. UI

**Processes panel** — `run 3` beside each step's status. Nothing else changes.

**Module page**

- A **run selector** in the header, latest selected by default. Authors do not
  see it; they always read the latest run.
- Selecting a past run must be **unmistakably read-only**: a persistent
  *"Viewing run 2 of 3 — not the current result"* bar, and the status line
  describes the **selected** run.
- Every module page carries an "as at" line even on the latest run
  (*"Run 3 of round 1 · as at 21 Aug 2026, 14:26"*), because the KRT editor next
  door shows live data and a silent divergence reads as a lost edit.

**Technical detail — new METADATA column, first position**

| | |
|---|---|
| Run | 3 of 3 (round 1) |
| Status | Partly complete |
| Requested by | Nicolas Kieffer (manual re-run) |
| Started / Finished | 21 Aug 2026, 14:26 → 14:26 |
| Duration | 15.7s |
| Attempts | 1 of 3 |
| Configuration | on (external) — **or** `off`, `demo`, taken from the run |
| Source | external |

A run of a **disabled** module shows the same table with an empty result and
`Configuration: off`, so the page reads as *"this module was switched off when
this ran"* rather than as an empty finding.

**Pipeline page.** Each step shows its run number and the run's **configuration
state**, not the current one. Today it shows no config at all, so a step that
was disabled during the run is indistinguishable from one that ran and found
nothing (§6.1).

---

## 11. What this deliberately does not change

- `submission_jobs` — still one row per (type, round). No new rows, ever.
- `getForSubmission`, the orchestrator, the consolidator, the suggestions diff —
  all keep reading the current row. History is additive; no consumer changes.
- Cancel, retry, gate and restart semantics.
- The KRT editor and the submission workflow, which remain live by design —
  they are where you *change* things, not where you read what happened.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Frozen page mistaken for a lost edit | the "as at" line on every module page, not only past runs (§10) |
| Selecting a run mistaken for restoring it | read-only bar, no write affordances on a past run |
| A history write failing a good run | wrapped; logs and continues (§4.3) |
| `run_number` duplication under the advance race | allocation inside the atomic claim + UNIQUE backstop (§4.1) |
| Storage growth | accepted (S3 + DB can grow); payload/record split leaves pruning open (§3.4) |
| Orphaned artefacts | hard delete already removes the whole S3 prefix; soft delete keeps it deliberately |
| Soft delete mistaken for the existing per-user "hidden" | three distinct states with distinct wording, and Hidden keeps its own dashboard section (§7.4) |
| A user soft-deleting and expecting to undo it | only admins can see soft-deleted submissions, so the confirmation must say "only an administrator can undo this" (§7.4) |
| The purge erasing something restored since the page loaded | re-classify at call time, as the Jobs admin cleanup already does (§7.4) |
| A soft-deleted submission still consuming LM budget | its queued work is cancelled, exactly as hard delete does (§7.4) |
| A hard delete leaving no trace of itself | the `submission_deletions` ledger holds plain values, not foreign keys, so it survives the cascade (§7.4) |

---

## 13. Phasing

1. **Schema + backfill + run number + file provenance.** Migration, model,
   lifecycle writes (every enqueue, §4.2), `files.uploaded_by_user_id` and
   `change_logs.file_id` (§7.2), and `run 3` in the panel with Technical
   detail's METADATA column. Ships useful on its own and proves the lifecycle
   before any page depends on it.
2. **Read a past run.** The two endpoints, the module-page selector, the
   read-only bar, role gating.
3. **Freeze the remaining live reads.** File links, markdown viewer, ORCID
   authors, the run's module config on the pipeline and module pages (§6.1 —
   display only, the data is already captured), the resource-type vocabulary
   (§6.2), and the "as at" line — plus S3 keyed by run number.

4. **Deletion policy.** `submissions.deleted`, the role split, the
   `submission_deletions` ledger, and the list/filter changes (§7.4).
   Independent of 1–3 and shippable at any point — but it only *means* anything
   once there is history worth preserving, which is why it sits after them.

Each phase is independently shippable, and phase 1 carries the risk (write
paths); 2 and 3 are additive reads.

---

## 14. Open questions

1. **Retention.** None proposed. If it is ever wanted, the payload/record split
   makes "keep the last N payloads, keep every record" a one-query job.
2. **Comparing two runs side by side.** Out of scope here, but the schema
   supports it and it is the obvious follow-on for the prompt-arm evaluation
   work in ticket 0046.
3. **Round-level view.** "Show me every run of round 1, across all steps" is a
   natural pipeline-page feature once the data exists.
4. ~~**Does deleting a submission erase its audit trail?**~~ **Decided
   2026-08-21** — soft delete by default (anyone with access, nothing removed),
   hard delete by an administrator only. See §7.4. The remaining sub-question is
   whether a hard delete should be blocked while a submission is under review —
   **decided: no.** A hard delete stops everything and removes it instantly.
   (User *deletion* was already safe: accounts are anonymised, not removed, so
   attribution survives as "Deleted user".)
