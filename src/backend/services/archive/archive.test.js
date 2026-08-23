'use strict';

/**
 * Archiving a submission, and putting it back.
 *
 * The property that matters is not that an export produces a file — it is that
 * the file RESTORES. An archive nobody has restored is a folder of hope, and
 * the whole point of deleting a submission is being sure it can come back. So
 * the round trip is tested against a real database in `archive-roundtrip`, and
 * what is tested here is the shape everything else depends on.
 *
 * Two of these read the live schema rather than a fixture, deliberately: a
 * table added to the database and forgotten in `archive-shape.js` would leave
 * rows behind on every export and every delete, silently, and no behavioural
 * test would notice.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const models = require('../../models');
const { TABLES, DELETE_ORDER } = require('./archive-shape');

/**
 * Tables with a `submissionId` that deliberately do NOT travel with it.
 *
 * Exactly one so far, and it has to be named rather than inferred: the
 * tombstone exists precisely because the submission does not, so archiving it
 * alongside the submission would be archiving the record of the archiving.
 * Restoring one would resurrect a tombstone for a submission that is back.
 */
const NOT_OWNED = new Set(['submission_archives']);

test('every table that belongs to a submission is in the shape', () => {
  // Read off the models rather than the database, so this runs without a
  // connection: a model with a `submissionId` attribute owns rows that go with
  // the submission.
  const owned = Object.entries(models)
    .filter(([name, m]) => typeof m?.getAttributes === 'function'
      && name !== 'Submission'
      && 'submissionId' in m.getAttributes())
    .map(([, m]) => m.getTableName())
    .filter((t) => !NOT_OWNED.has(t));

  const covered = new Set(TABLES.map((t) => t.table));
  const missing = owned.filter((t) => !covered.has(t));

  assert.deepEqual(missing, [],
    'these hold submission rows that an export would leave behind and a delete would orphan');
});

test('the delete order covers exactly the tables the export writes', () => {
  // Two lists that must not drift. A table in one and not the other is either
  // an export that cannot be restored or a delete that leaves rows.
  assert.deepEqual(
    [...DELETE_ORDER].sort(),
    TABLES.map((t) => t.table).sort()
  );
});

test('membership is deleted before the executions it points at', () => {
  // `pipeline_run_steps.step_execution_id` is ON DELETE RESTRICT: the database
  // refuses the other order. That refusal is the constraint working — it has
  // already caught a real bug in the failure seeder — and getting the order
  // wrong here turns every deletion into an error.
  assert.ok(
    DELETE_ORDER.indexOf('pipeline_run_steps') < DELETE_ORDER.indexOf('step_executions'),
    'RESTRICT means membership goes first'
  );
});

test('a table is only inserted after the tables it points at', () => {
  // The insert order, checked against the models' own foreign keys rather than
  // asserted by hand.
  const position = new Map(TABLES.map((t, i) => [t.table, i]));
  const problems = [];

  for (const spec of TABLES) {
    const attrs = models[spec.model].getAttributes();
    for (const [field, def] of Object.entries(attrs)) {
      const target = def.references?.model;
      if (!target || target === 'submissions' || target === 'users') continue;
      if (target === spec.table) continue;                    // self-reference: deferred
      if (!position.has(target)) continue;                    // outside the archive
      if (position.get(target) > position.get(spec.table)) {
        problems.push(`${spec.table}.${field} → ${target}, which comes later`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('a self-referencing table is marked as one', () => {
  // Missing the marker means bulkCreate hits a row whose parent is later in the
  // same file, and the whole restore fails on a foreign key.
  const selfRefs = [];
  for (const spec of TABLES) {
    for (const [field, def] of Object.entries(models[spec.model].getAttributes())) {
      if (def.references?.model === spec.table) selfRefs.push({ table: spec.table, field });
    }
  }

  for (const { table, field } of selfRefs) {
    const spec = TABLES.find((t) => t.table === table);
    assert.equal(spec.selfRef, field,
      `${table}.${field} points at its own table and must be declared as selfRef`);
  }
  assert.ok(selfRefs.length >= 2, 'krt_data and pipeline_runs both self-reference');
});

test('the tombstone outlives the submission, so it never travels with it', () => {
  // Naming it in NOT_OWNED is a decision, and a decision needs a reason on
  // record: archiving the tombstone would archive the record of the archiving,
  // and restoring it would resurrect a tombstone for a submission that is back.
  assert.ok(
    'submissionId' in models.SubmissionArchive.getAttributes(),
    'it does name a submission — which is exactly why the exclusion is deliberate'
  );
  assert.ok(
    !TABLES.some((t) => t.table === 'submission_archives'),
    'and it must never be in the export'
  );
  // And no foreign key, because what it names is gone.
  assert.equal(models.SubmissionArchive.getAttributes().submissionId.references, undefined);
});
