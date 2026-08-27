'use strict';

/**
 * Export a submission, delete it, put it back, and check it is the same one.
 *
 * The only test that matters for retention. Everything else here checks the
 * SHAPE of an archive; this checks that it restores — and an archive nobody has
 * restored is a folder of hope. Deleting a submission is only defensible if
 * this passes, which is why the delete path refuses to run without a verified
 * archive at all.
 *
 * ── Why it skips without a database ─────────────────────────────────────────
 *
 * The rest of the backend suite is hermetic: it mocks the models and runs with
 * no connection, which is what makes it fast enough to run on every change. A
 * round trip cannot be faked — mocking the database would test the mock — so
 * this skips when there is nothing to talk to, and runs in full when there is:
 *
 *     cd src/backend && node --test services/archive/archive-roundtrip.test.js
 *
 * It writes: it creates a submission, deletes it, and restores it. It uses its
 * own throwaway submission and removes it at the end, so it never touches
 * anything a person made.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const models = require('../../models');
const archive = require('./archive.service');
const { TABLES } = require('./archive-shape');

// Without this the runner waits on the connection pool for ever, and the only
// symptom is a test file that never finishes — which is how this one first
// behaved.
after(() => models.sequelize.close());

/** True when a real database is reachable. */
async function hasDatabase() {
  try {
    await models.sequelize.authenticate();
    return true;
  } catch {
    return false;
  }
}

/** Count every owned row, the way the archive defines "owned". */
async function census(submissionId) {
  const out = {};
  for (const spec of TABLES) {
    const where = spec.via
      ? {
        [spec.by]: (await models.PipelineRun.findAll({
          where: { submissionId }, attributes: ['id']
        })).map((r) => r.id)
      }
      : { [spec.by]: submissionId };
    out[spec.table] = (spec.via && !where[spec.by].length)
      ? 0
      : await models[spec.model].count({ where });
  }
  out.submissions = await models.Submission.count({ where: { id: submissionId } });
  return out;
}

test('a submission survives being archived, deleted and restored', async (t) => {
  if (!await hasDatabase()) {
    t.skip('no database reachable — run this against a real instance');
    return;
  }

  const user = await models.User.findOne();
  assert.ok(user, 'the instance needs at least one user');

  // A submission of its own, with something in every interesting table: a
  // round trip over an empty submission proves almost nothing.
  const submission = await models.Submission.create({
    userId: user.id,
    title: '[archive round-trip] delete me',
    manuscriptId: 'AR1-000001-001-org-X-1',
    currentRound: 1
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-roundtrip-'));

  try {
    const job = await models.SubmissionJob.create({
      submissionId: submission.id, jobType: 'materials_detection', status: 'complete', round: 1
    });
    const run = await models.PipelineRun.open({
      submissionId: submission.id, round: 1, cause: 'create_submission', causedByUserId: user.id
    });
    // A SECOND run, whose parent is the first: the self-reference is the part
    // a naive restore gets wrong, because a row can name a parent that is
    // later in the same file.
    const child = await models.PipelineRun.open({
      submissionId: submission.id, round: 1, cause: 'restart', parentRunId: run.id
    });
    const execution = await models.StepExecution.create({
      pipelineRunId: run.id, submissionJobId: job.id, submissionId: submission.id,
      jobType: 'materials_detection', round: 1, status: 'complete',
      counts: { unique: 7 }, result: { data: { items: [1, 2, 3] } }
    });
    await models.PipelineRunStep.create({
      pipelineRunId: run.id, jobType: 'materials_detection', stepExecutionId: execution.id
    });
    // Carried over into the child run — the link the archive must preserve.
    await models.PipelineRunStep.create({
      pipelineRunId: child.id, jobType: 'materials_detection',
      stepExecutionId: execution.id, carriedOver: true
    });
    const krtRow = await models.KRTData.create({
      submissionId: submission.id, round: 1, resourceType: 'Antibody', resourceName: 'anti-X'
    });
    // A KRT row that points at another KRT row: the other self-reference.
    await models.KRTData.create({
      submissionId: submission.id, round: 1, resourceType: 'Antibody', resourceName: 'anti-Y',
      originRowId: krtRow.id
    });
    await models.ChangeLog.create({
      submissionId: submission.id, userId: user.id, action: 'apply', source: 'pipeline',
      round: 1, columnName: 'authors', stepExecutionId: execution.id
    });

    const before = await census(submission.id);

    // ── export ──────────────────────────────────────────────────────────────
    const manifest = await archive.exportSubmission(submission.id, dir);
    assert.equal(manifest.submission.id, submission.id);
    assert.equal(manifest.tables.pipeline_runs.rows, 2);
    assert.equal(manifest.tables.pipeline_run_steps.rows, 2);
    assert.ok(manifest.tables.users.rows >= 1, 'the users it references travel with it');

    // ── the archive checks itself ───────────────────────────────────────────
    const damaged = path.join(dir, 'data', 'krt_data.ndjson');
    const good = await fs.readFile(damaged);
    await fs.writeFile(damaged, Buffer.concat([good, Buffer.from('{"id":"x"}\n')]));
    await assert.rejects(() => archive.readArchive(dir), /damaged/,
      'a truncated or altered archive must not restore quietly');
    await fs.writeFile(damaged, good);

    // ── delete ──────────────────────────────────────────────────────────────
    await assert.rejects(() => archive.deleteSubmission(submission.id), /has not been archived/,
      'nothing is deleted without a verified archive');

    await archive.deleteSubmission(submission.id, { archiveDir: dir });
    const gone = await census(submission.id);
    assert.deepEqual(Object.values(gone).filter((n) => n !== 0), [],
      'every owned row goes, or the submission is only half deleted');

    // ── restore ─────────────────────────────────────────────────────────────
    const restored = await archive.importSubmission(dir);
    assert.equal(restored.submissionId, submission.id);

    const after = await census(submission.id);
    assert.deepEqual(after, before, 'the same rows, in the same numbers');

    // Not just counts. The two things a naive restore breaks:
    const runs = await models.PipelineRun.findAll({
      where: { submissionId: submission.id }, order: [['runNumber', 'ASC']]
    });
    assert.equal(runs[1].parentRunId, runs[0].id, 'the run lineage survives');

    const rows = await models.KRTData.findAll({
      where: { submissionId: submission.id }, order: [['resourceName', 'ASC']]
    });
    assert.equal(rows[1].originRowId, rows[0].id, 'so does a row that came from another row');

    const members = await models.PipelineRunStep.findAll({
      where: { pipelineRunId: runs.map((r) => r.id) }
    });
    assert.equal(new Set(members.map((m) => m.stepExecutionId)).size, 1,
      'a carried-over step still points at the one execution, not a copy');

    // ── and it refuses to restore twice ─────────────────────────────────────
    await assert.rejects(() => archive.importSubmission(dir), /already here/);

    // ── the tombstone ───────────────────────────────────────────────────────
    //
    // Recorded on delete, CLOSED on restore rather than removed: "archived in
    // March, restored in May" is a truer record than a row that quietly
    // disappears, and once the archive folder is gone it is the only place that
    // history exists.
    const stones = await models.SubmissionArchive.findAll({
      where: { submissionId: submission.id }
    });
    assert.equal(stones.length, 1, 'one delete, one tombstone');
    assert.ok(stones[0].restoredAt, 'and the restore closed it');
    assert.equal(stones[0].manuscriptId, 'AR1-000001-001-org-X-1');
    assert.match(stones[0].manifestSha256, /^[0-9a-f]{64}$/);

    const missing = await models.SubmissionArchive.listMissing();
    assert.ok(!missing.some((m) => m.submissionId === submission.id),
      'a restored submission is no longer missing');
  } finally {
    await archive.deleteSubmission(submission.id, { archiveDir: dir }).catch(() => {});
    await models.Submission.destroy({ where: { id: submission.id } }).catch(() => {});
    // The tombstones this test made are its own litter, not history worth
    // keeping — a real one is never deleted.
    await models.SubmissionArchive.destroy({ where: { submissionId: submission.id } }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * The dashboard's delete, on a submission that has run the pipeline.
 *
 * `pipeline_run_steps.step_execution_id` is ON DELETE RESTRICT so that
 * retention cannot hollow out a run that carried a step over from an earlier
 * one. Nothing can therefore rely on the cascade: the membership rows have to
 * come out before the executions they name.
 *
 * The retention path knew that — `DELETE_ORDER` puts `pipeline_run_steps`
 * first. The controller did not: it called `submission.destroy()` and let
 * Postgres cascade, which walks into the RESTRICT. Every admin delete of a
 * submission that had run the pipeline returned 400 with
 * `violates foreign key constraint "pipeline_run_steps_step_execution_id_fkey"`,
 * and because S3 was emptied first, the files were already gone by then.
 *
 * A carried-over step is what makes this bite, so this builds one: two runs
 * pointing at a single execution, which is the row RESTRICT is protecting.
 */
test('deleting a submission that has carried a step over succeeds', async (t) => {
  if (!await hasDatabase()) {
    t.skip('no database reachable — run this against a real instance');
    return;
  }

  const user = await models.User.findOne();
  assert.ok(user, 'the instance needs at least one user');

  const submission = await models.Submission.create({
    userId: user.id,
    title: '[delete path] delete me',
    manuscriptId: 'DP1-000001-001-org-X-1',
    currentRound: 1
  });

  const job = await models.SubmissionJob.create({
    submissionId: submission.id, jobType: 'materials_detection', status: 'complete', round: 1
  });
  const run = await models.PipelineRun.open({
    submissionId: submission.id, round: 1, cause: 'create_submission', causedByUserId: user.id
  });
  const child = await models.PipelineRun.open({
    submissionId: submission.id, round: 1, cause: 'restart', parentRunId: run.id
  });
  const execution = await models.StepExecution.create({
    pipelineRunId: run.id, submissionJobId: job.id, submissionId: submission.id,
    jobType: 'materials_detection', round: 1, status: 'complete'
  });
  await models.PipelineRunStep.create({
    pipelineRunId: run.id, jobType: 'materials_detection', stepExecutionId: execution.id
  });
  // The row that RESTRICT exists for: a second run naming the FIRST run's
  // execution. Without this the cascade happens to succeed and the bug hides.
  await models.PipelineRunStep.create({
    pipelineRunId: child.id, jobType: 'materials_detection',
    stepExecutionId: execution.id, carriedOver: true
  });

  const rows = await archive.removeSubmissionRows(submission.id);

  assert.equal(rows.pipeline_run_steps, 2, 'both membership rows should come out');
  assert.equal(rows.step_executions, 1);
  assert.equal(rows.submissions, 1);

  const left = await census(submission.id);
  for (const [table, n] of Object.entries(left)) {
    assert.equal(n, 0, `${table} still holds ${n} row(s) after the delete`);
  }
});
