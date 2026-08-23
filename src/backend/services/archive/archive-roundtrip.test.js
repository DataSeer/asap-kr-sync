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
  } finally {
    await archive.deleteSubmission(submission.id, { archiveDir: dir }).catch(() => {});
    await models.Submission.destroy({ where: { id: submission.id } }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
