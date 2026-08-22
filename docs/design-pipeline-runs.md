# Design proposal — Pipeline runs: one coherent attempt, reconstructable in full

**Status:** PROPOSED · **Created:** 2026-08-22

> Supersedes the run model in [design-run-history.md](./design-run-history.md),
> which numbers runs **per step**. That model is built and working; this one
> replaces its central identity while keeping almost all of its machinery —
> payload/record split, S3 keying, guarded writes, the freeze table.
>
> The trigger for the change: a per-step run number cannot answer *"which runs
> belong together"*, so the result a user is looking at is a **mix** — software
> run 3, materials run 1, grounding run 2 — with no name for the set and no
> ordering except timestamps.

**Scope:** the pipeline's identity model, what a step is allowed to write, and
what a run must record to be replayable.
**Intended for reuse:** the model is deliberately independent of this app's
modules, so it can be lifted into other projects.

---

## 1. The four levels

Each answers a different question. Three exist today; one does not, and its
absence is the reason for this document.

| Level | One of these is… | Identified by | Today |
|---|---|---|---|
| **Round** | a version of the manuscript | `round` | ✅ |
| **Pipeline run** | one coherent attempt at processing that round | `run_number` per round | ❌ **missing** |
| **Step execution** | one step actually doing work | its own row | ✅ (numbered per step) |
| **Attempt** | one try inside an execution — the two 529s before the success | index in `attempts[]` | ❌ **missing** |

There is deliberately **no** global "run 7 of everything". Selective restart
means a pipeline run legitimately contains steps executed at different times;
what makes it coherent is that the run *declares* which execution each step
contributes, not that they all happened at once.

### 1.1 Vocabulary

Fixed, because "run" is currently used for two of these:

- **pipeline run** — the collection. What a user means by "run 2".
- **step execution** — one step doing work. Immutable once finished.
- **carried over** — a step whose entry in run N+1 points at run N's execution
  rather than executing again.
- **apply** — the act of promoting a step's output into the submission's own
  data. Separate from execution (§6).

---

## 2. The governing principle

> **A pipeline run is a complete, self-consistent description of one attempt.**
> Everything needed to understand, audit or replay it is reachable from the run
> alone, without reading the submission's current state.

Two rules follow, and everything else in this document is a consequence:

1. **A step writes only to its own execution.** Anything that changes the
   submission is a separate, attributed *apply* (§6).
2. **A finished execution's output is immutable.** Its *disposition* — the
   decision attached to it, its membership in later runs — is append-only (§8).

---

## 3. Data model

### 3.1 `pipeline_runs`

One row per attempt.

| Column | Notes |
|---|---|
| `id` | |
| `submission_id`, `round` | |
| `run_number` | 1-based per (submission, round); allocated inside the INSERT |
| `cause` | `create_submission` \| `retry` \| `restart` \| `new_document` \| `replay` |
| `caused_by_user_id` | null for automatic causes |
| `parent_run_id` | what it was derived from |
| `status` | `running` \| `paused` \| `complete` \| `superseded` |
| `shape` | JSONB: the step list, each step's `dependsOn` / `optional` / config state (§7) |
| `pipeline_version` | integer, **manually** bumped when the structure changes |
| `app_version` | commit/build that produced it. Provenance only — never read for compatibility |
| `created_at`, `completed_at` | |

`superseded` is a real state: a run replaced before it finished is neither
complete nor abandoned, and without the state its `status` is a lie for ever.

### 3.2 `step_executions`

One row per real execution. Immutable output (§8).

| Column | Notes |
|---|---|
| `id`, `pipeline_run_id` | the run that **created** it |
| `submission_id`, `round`, `job_type` | denormalised, so history is queryable without joins |
| `status` | `complete` \| `failed` \| `cancelled` \| `skipped` |
| `outcome_state` | `done` \| `partial` \| `fail` |
| `fail_reason`, `external_error` | |
| `attempts` | JSONB `[{ n, at, ok, error, http_status, engine }]` (§5) |
| `config` | the config **as this execution saw it** — may differ from the run's `shape` |
| `counts`, `result`, `logs`, `inputs` | the payload. Nullable, so it can be pruned without losing the record |
| `tokens` | `{ promptTokens, outputTokens, totalTokens, calls }` |
| `s3_prefix` | `jobs/<jobType>/run-<pipelineRunNumber>` |
| `decision` | `{ at, by_user_id, choice }` — about **this** execution (§4.4) |
| `skip_reason` | `{ missing: [jobType] }` when skipped |
| `cancelled_at`, `cancelled_by_user_id`, `discarded` | §9 |
| `started_at`, `completed_at`, `duration_ms` | |

### 3.3 `pipeline_run_steps`

Membership. What run N *contains*.

| Column | Notes |
|---|---|
| `pipeline_run_id`, `job_type` | `UNIQUE` together |
| `step_execution_id` | `ON DELETE RESTRICT` — retention may not gut a live run |
| `carried_over` | true when it points at an execution another run created |

A membership row may point at an execution that has **not finished yet** (§9).

### 3.4 What `submission_jobs` becomes

It stops being history and becomes what the scheduler needs, and only that:
current pipeline run, live status, `pg_boss_job_id`, round, job type. Every
historical and decision field moves out.

### 3.5 `change_logs` gains provenance

Applies are recorded on the table that already records who/what/when, plus one
column: **`step_execution_id`**. One row then answers *"this statement came from
run 2's extraction, accepted by Nicolas at 14:02"*, and an auto-apply is the
same row with the system as actor.

---

## 4. Creating a pipeline run

The whole algorithm:

```
newRun(parent, reRun[], inputChoices, cause, user)
  1. reRun ∪= everything downstream of a re-run step
     A carried-over result built without software's findings is stale the moment
     software succeeds. Non-negotiable.
  2. carriedOver = allSteps − reRun
  3. inputs: for each of pdf / markdown / krt, inherit the parent's freeze or
     take the current version, per inputChoices
  4. shape: record the step list, dependencies and config state as they are NOW
  5. membership: carriedOver → parent's execution, carried_over = true
                 reRun       → null, filled when they execute
  6. mark the parent `superseded` if it was still running
  7. enqueue re-run steps whose dependencies are satisfied
```

### 4.1 Every operation is this one operation

| Operation | `reRun` | `inputChoices` |
|---|---|---|
| create submission | everything | current |
| retry one step | `[step]` | inherit |
| restart from here | `[step]` | inherit (or chosen) |
| restart a selection | the picked steps | inherit (or chosen) |
| new document | everything | current |
| replay (§10) | everything | **inherit**, with the parent's prompts and config |

Retry and restart stop being different mechanisms. Only the copy rule differs —
which was the insight this design came from.

### 4.2 Continue is not a new run

Continuing past an issue records a **decision on the execution** and lets the
current run proceed. It creates no run, because nothing is re-executed.

### 4.3 What holds a run

A dependency holds its dependents unless it finished **cleanly**:

| Finished step | Clean? | Effect |
|---|---|---|
| results | ✅ | carries on |
| **nothing found** | ✅ | carries on — a detector finding nothing is an answer |
| partial | ❌ | pauses, unless the dead engine is on that module's auto-continue list |
| total error | ❌ | pauses |
| completed producing nothing usable | ❌ | pauses |

When paused: **Retry** (a new run) or **Continue** (a decision). What Continue
costs is computed, not guessed:

- **optional** data missing → dependants run, degraded
- **required** data missing → dependants are **skipped**, recording what was
  missing

### 4.4 Decisions carry over — and must say so

Carrying over an execution carries its decision with it: you kept the execution,
you kept what was decided about it. Otherwise the same question is asked every
time anything else is touched.

**The UI must always mark a carried-over step as carried over, and name the run
it came from.** This applies to results as much as decisions — it is what stops
"why does this say 14 items when I just re-ran it".

---

## 5. Attempts

Two retry layers, and only one is visible today:

| Layer | Where | Recorded today |
|---|---|---|
| queue re-delivery | pg-boss `retryLimit` | only as a count |
| in-client retry | the shared Gemini wrapper, Softcite client | **not at all** |

`retry_count: 2` with an overwritten error cannot answer *"the first two attempts
returned 529, then it succeeded"*. `attempts[]` on the execution can, appended at
both layers — the second via the ambient `AsyncLocalStorage` pattern that token
counting already uses, so no service needs to change.

Fixed in passing: `markComplete` never clears `errorMessage`, so an execution
that succeeded on its third attempt currently carries the second attempt's error
into its record.

---

## 6. The apply system

**The single most important change here.** Today several steps write to the
submission directly, which means a run is *not* a snapshot:

| Step | Writes | Consequence |
|---|---|---|
| DAS Extraction | `submissions.data_availability_statement` | viewing run 1 shows run 2's statement |
| ORCID Extraction | `submissions.authors` | same |
| suggestion application | `krt_data` | user-driven, but unattributed to a run |

The rule:

> **A step writes only to its own execution. Promoting output into the
> submission is a separate, attributed act.**

- **DAS** — extraction stores its answer in the execution. The submission's
  statement is set only when the user accepts it on the Availability step. This
  also dissolves the awkward `extracted_…` / `…_statement` pair: the "extracted"
  value is simply the latest extraction execution's output.
- **ORCID** — same mechanism, auto-accepted, so it is logged and attributable
  rather than silent.
- **Suggestions** — already user-driven; the apply is recorded with the
  execution that proposed it.

Every apply is a `change_logs` row with `step_execution_id`.

The payoff beyond snapshots: **a run can be re-executed without touching the
submission at all**, which is what makes replay and evaluation possible.

### 6.1 Two "current" states, never blurred

| | Source | Shown on |
|---|---|---|
| what a module **produced** | the execution, per run | module pages, pipeline page |
| what the submission **holds** | applied values | KRT editor, Availability, the report |

This is the real resolution of "which run is the result from": the displayed KRT
is not run 3's output, it is the submission's state, with provenance pointing at
whichever executions were applied. They may come from different runs, and that
is correct — they are applies, not results.

---

## 7. Freezing what the run used

Per pipeline run rather than per round:

- **inputs** — the PDF, converted markdown and KRT snapshot the run read
- **shape** — the step list, each step's dependencies and optional set, and each
  step's config state
- **prompts** — already stored per execution
- **`pipeline_version`** — manual, governs whether today's code can read the run
- **`app_version`** — automatic, provenance only

`shape` is not redundant with the per-execution `config`. Config is written when
a module *finishes*, so a step that never ran has none — on a blocked round
today, **1 of 12** steps has any config record. Without `shape`, "was software
detection switched off during run 2" is unanswerable exactly when it matters,
and "identifier detection is absent" cannot be told from "identifier detection
did not exist yet".

---

## 8. Immutability

> An execution's **output** is immutable once it completes. Its **disposition** —
> the decision attached to it, and its membership in later runs — is append-only.

Stated this way because a decision is recorded *after* the execution finishes; a
literal "nothing may be written" rule would be broken by the first thing the
system does.

Enforcement: application-level guard plus `ON DELETE RESTRICT` from membership,
so no retention job can remove an execution a live run still carries.

---

## 9. Cancellation

A cancel **interrupts**: the execution becomes `cancelled`, is unusable, and the
step must be re-run.

But an in-flight external call cannot actually be stopped — the promise is
abandoned; the call completes and is billed. So the execution records:

- `cancelled_at`, `cancelled_by_user_id`
- the response, if one arrives, with `discarded: true` and its own timestamp

So "did we pay for something we threw away, and who threw it away" is answerable
rather than inferred. No further attempts are made after a cancel: the current
try finishes or fails, and that is the end of it.

---

## 10. Replay vs restart

Two different buttons, one frozen dataset:

- **Replay** — same inputs, same prompts, same config, same code version where
  possible. For "why did it do that". Diagnostic; may be run into a scratch
  space rather than becoming the current run.
- **Restart** — current code, current config, chosen inputs. What Retry does.

---

## 11. Concurrency and staleness

**The client refreshes by domain; the server decides by target.**

The client refreshes the relevant data before any mutating action — KRT before a
KRT edit, suggestions and KRT before accepting a suggestion, pipeline before a
restart — and tells the user if what they were looking at had moved.

That is a UX affordance, not the guarantee. **The correctness check is
server-side**: the request carries what the client believed — the execution id,
the suggestion id, the row version — and the server refuses on mismatch. A
second user, a stale tab or a replayed request cannot be defended against on the
client.

Scope matters for the pipeline specifically: it changes continuously without
anyone acting, so a domain-wide check would reject users for changes irrelevant
to what they clicked. Refresh the domain, then proceed only if the **targeted
object** is unchanged.

Run creation is serialised the way `run_number` already is — allocated inside
the INSERT with `UNIQUE (submission_id, round, run_number)` — and a second
concurrent creation is refused with a conflict rather than silently forking.

---

## 12. Retention

Prune by **execution**, never by run, and never one referenced by a live
membership row. The record/payload split makes this safe: drop `result`, `logs`
and S3 artefacts; keep the row, its outcome, its attempts and its decision.

---

## 13. What this keeps from the current implementation

Most of it. The change is one of identity, not of machinery:

- guarded history writes (with the exception in §14)
- payload/record split and nullable payloads
- S3 keyed by run
- the input-freeze table and its "first reader freezes" rule
- the issue predicate, the partial auto-continue policy, `optional` edges,
  `produced()` on the producer, and the skip rule — all built and tested
- the shared issues panel and the four actionable surfaces

---

## 14. Decisions taken

1. **No global run number across rounds.** A pipeline run belongs to a round.
2. **Carried-over, not copied.** Membership links; payloads are never duplicated.
3. **Decisions carry over**, and the UI always says a step was carried over.
4. **Cancel interrupts**, but the response is still recorded as discarded.
5. **Applies are separate from executions**, and logged with provenance.
6. **Two versions**: `pipeline_version` (manual, compatibility) and `app_version`
   (automatic, provenance). Recording is not invalidating.
7. **A decision write is not a background write** — it is un-guarded, because the
   orchestrator depends on it. The rule becomes: *background history writes never
   break a run; a decision is not a background write.*

## 15. Open questions

1. **Does `pending_input` become an issue?** The DAS confirmation blocks
   `das_suggestions` and has its own banner, but never appears in the issues
   list. It is the same shape of thing — a step waiting on a person — and two
   mechanisms for that will drift.
2. **Is cancellation an issue?** A cancelled step raises none today, and cancels
   its dependants silently. A cancelled round is invisible beside a failed one.
3. **Should PDF Analysis require at least one detector?** With no manuscript it
   currently still runs on the author's rows, producing a report that reads like
   an analysis of a paper nobody could read.
4. **Where does a replay's output go** — a real pipeline run, or a scratch space
   that never becomes current?
5. **Round and pipeline run overlap.** `/new-round` is nearly "a run with new
   documents". Keeping both is right for now; whether rounds eventually become a
   flag on a run is open.

## 16. Migration order

Each step leaves the system working:

1. **Schema + run creation.** New tables, `newRun()`, writing alongside the
   current model. The scheduler is untouched.
2. **Attempts and the apply system.** Independent of the identity change and
   valuable on their own; the apply split is the one to do early, because
   retrofitting it later means revisiting every module.
3. **Move history reads** — module pages, run endpoints, report — onto runs.
4. **Retire per-step run numbers** and shrink `submission_jobs`.
5. **The run selector becomes submission-wide**: "show me run 1" across every
   module, rather than per step.

No backfill. There is no production data, and the standing rule for this
project is no backward-compatibility fallbacks — a run recorded under the old
per-step numbering is read by the old code path until step 4 removes both.
