# Archiving a submission

A submission can be taken out of the live instance and put into a folder, and
put back from it. The unit is always the **submission**: everything it owns
leaves together or not at all, because a half-archived submission is neither
restorable nor safely deletable.

```bash
node scripts/archive-submission.js --export <submissionId> --out <dir>
node scripts/archive-submission.js --import <dir> [--dry-run]
node scripts/archive-submission.js --delete <submissionId> --archive <dir>
```

The three are separate commands on purpose. **Deleting takes an archive
directory and verifies it before touching anything**, so a submission can only
be removed once a copy has been read back and checked. "Archive then delete" as
one command would make that check something a flag could skip.

## What an archive holds

```
manifest.json          archive version, app version, per-table row counts and digests
data/*.ndjson          one file per table, in restore order
s3/<key>               the submission's objects, at their real keys
```

A real one, for a submission with fourteen pipeline runs: **361 rows across 12
tables, 148 S3 objects, 74 MB** — almost all of it S3.

### Row data, not SQL

An archive is meant to be kept offline and restored later, **after the schema
has moved**. A `.sql` script restores trivially into the schema it was taken
from, and either fails or — worse — half-succeeds into a different one; "easy to
restore" is then only true at the moment you write it. This schema moved seven
migrations in a single day.

NDJSON plus a restore that goes through the models can map a renamed field,
default a new one, and refuse loudly when it cannot. It is also testable, which
is the point: **an archive nobody has restored is a folder of hope.**

One row per line rather than one big JSON, so it streams and a table can be
eyeballed.

### The manifest is what makes a restore verifiable

Row counts and a SHA-256 per file. `readArchive` checks both before writing
anything, so a truncated or altered archive is refused rather than restored
quietly — the failure that would make the whole feature untrustworthy.

## What travels, and what must already be there

A submission owns twelve tables and points outward at exactly one thing:
`users`. Those rows travel too, and on restore:

- an **existing** user is reused, never overwritten — an archive is a copy of a
  moment, and a live account that has changed role or been anonymised since must
  not be reverted by restoring an old submission;
- a **missing** one is recreated as an anonymised placeholder with no password
  and `isActive: false`, so *"applied by Nicolas"* survives a restore into an
  instance that never had Nicolas, without moving a credential.

## Order, three times

`archive-shape.js` holds one table list, used by the export, the import and the
delete — a table added to the schema and forgotten there would be left behind by
all three, silently. `archive.test.js` compares the list against the models'
own foreign keys and fails when they disagree.

- **Insert** follows the list: a row cannot reference one that is not there yet.
- **Delete** reverses it, with one asymmetry that is not conventional:
  `pipeline_run_steps.step_execution_id` is `ON DELETE RESTRICT`, so membership
  goes before the executions it points at or Postgres refuses. That refusal is
  the constraint working — it has already caught a real bug in the failure
  seeder.
- **Export** reads in insert order, so the manifest lists tables the way they
  will be restored.

### Self-references

`krt_data.origin_row_id` and `pipeline_runs.parent_run_id` point within their
own table, so a row can name a parent later in the same file. They are inserted
with the reference nulled and set in a second pass. Missing that marker on a new
self-referencing table would fail the whole restore on a foreign key, so
`archive.test.js` derives the list from the models rather than trusting the
declaration.

## S3

Walked with `listPrefix`, not derived from the `files` table: job artefacts are
keyed by run and named by the module, and **only S3 knows what is actually
there**. Objects are uploaded after the database transaction commits — S3 has no
rollback, and a failed upload leaving objects behind is recoverable, where a
transaction held open across a hundred network writes is not.

## Proving it still works

`archive-roundtrip.test.js` creates a submission, exports it, damages the
archive and checks it is refused, deletes the submission, restores it, and
compares. It asserts more than row counts: the run lineage, a KRT row that came
from another row, and that a carried-over step still points at **one** execution
rather than a copy.

It **skips when no database is reachable**, so the hermetic suite stays fast,
and runs in full against a real instance:

```bash
cd src/backend && node --test services/archive/archive-roundtrip.test.js
```

## The tombstone

Deleting records a row in `submission_archives`: what left, when, by whom, where
it went, and the SHA-256 of the manifest. A dashboard that silently loses a
submission is alarming; *"archived 3 March, restorable, checksum abc123"* is not.

```bash
node scripts/archive-submission.js --list
```

Three decisions worth knowing:

- **It is written before the delete, not after.** If the delete then fails half
  way, the worst case is a tombstone for something still here — visible and
  correctable. The other order risks a submission that has vanished with nothing
  saying where it went, which is the state this table exists to make impossible.
- **It has no foreign key to `submissions`**, because what it names is gone.
- **A restore closes it rather than removing it.** "Archived in March, restored
  in May" is a truer record than a row that quietly disappears — and once the
  archive folder is gone, it is the only place that history exists.

It is also the one table with a `submission_id` that must never travel with the
submission: archiving it would archive the record of the archiving, and
restoring it would resurrect a tombstone for a submission that is back.
`archive.test.js` names the exclusion so it stays a decision rather than an
oversight.

## Retention

Two halves, kept apart on purpose:

```bash
node scripts/retention.js --select --project CS --status completed
node scripts/retention.js --select --untouched-since 2026-01-01 --ids-only > ids.txt
node scripts/retention.js --archive-from ids.txt --out <dir> --confirm
```

**Selection reads. Archiving takes ids and nothing else.**

A criterion is a claim about the future: *"everything in project CS"* means
whatever matches when it runs, which is not necessarily what somebody reviewed
five minutes earlier — a submission created in between, a status changed by
someone else. Handing over ids means the thing deleted is the thing that was
looked at.

It also makes the dangerous call impossible to write by accident. There is no
argument shape meaning "everything in this project": deleting a hundred
submissions requires first holding a hundred ids, which is a step a person
takes deliberately. `retention.test.js` reads the function's own signature and
fails if a criterion is ever added to it.

Selection criteria, all optional and combining with AND: `--project`, `--user`,
`--status` (one or several), `--untouched-since`, `--created-before`, `--limit`.
Results come back least-recently-touched first, since those are the likeliest
candidates.

### What the archiving half guarantees

- **Export, verify, then delete** — in that order, per submission. The
  verification re-reads the archive off disk; the export having just written it
  is not the same thing, and this is the only check that the bytes are readable.
- **One failure does not stop the batch, and does not delete that submission.**
  Failures are reported last and set a non-zero exit, because a run that reports
  only its successes is how a submission goes missing from a list nobody
  re-reads.
- **`--confirm` is required above three.** There is no flag that selects and
  deletes in one go: the review is the feature.
- **`--dry-run` still writes the archives** — verifying one means reading it
  back — and only withholds the delete. The output says so rather than letting
  "dry" imply nothing happened.

### Not built

Nothing schedules this. There is no sweep and no cron: the selection produces a
list, a person looks at it, and hands it back. That judgement is not one a
timer can make.
