'use strict';

/**
 * Choosing what to archive, and archiving it.
 *
 * The property worth protecting is the SEPARATION: selection reads and produces
 * a list, archiving takes ids and nothing else. A criterion is a claim about
 * the future — "everything in project CS" means whatever matches when it runs,
 * which is not necessarily what somebody reviewed five minutes earlier. Ids
 * mean the thing deleted is the thing that was looked at.
 *
 * It also makes the dangerous call unwritable by accident: there is no argument
 * shape meaning "everything in this project", so deleting a hundred submissions
 * requires first holding a hundred ids.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const models = require('../../models');
const archive = require('./archive.service');
const retention = require('./retention.service');

test('archiving refuses an empty list rather than treating it as "all"', async () => {
  // The failure mode this guards is not a crash — it is a helpful-looking
  // default. An empty list must never mean everything.
  await assert.rejects(() => retention.archiveAndDelete([], { outDir: '/tmp/x' }),
    /explicit list/);
  await assert.rejects(() => retention.archiveAndDelete(null, { outDir: '/tmp/x' }),
    /explicit list/);
});

test('and refuses to run without somewhere to put the archives', async () => {
  await assert.rejects(() => retention.archiveAndDelete(['a']), /somewhere to write/);
});

test('a submission that cannot be archived is not deleted, and is reported', async (t) => {
  // One bad id must not stop the batch, and must not be quietly dropped either:
  // a run that reports only its successes is how a submission goes missing from
  // a list nobody re-reads.
  t.mock.method(models.Submission, 'findByPk', async (id) => (
    id === 'good' ? { id: 'good', manuscriptId: 'M1' } : null
  ));
  const deleted = [];
  t.mock.method(archive, 'exportSubmission', async () => ({ tables: { submissions: { rows: 1 } } }));
  t.mock.method(archive, 'readArchive', async () => ({}));
  t.mock.method(archive, 'deleteSubmission', async (id) => {
    deleted.push(id);
    return { rows: { submissions: 1 }, objects: 0 };
  });

  const { done, failed } = await retention.archiveAndDelete(['good', 'missing'], { outDir: '/tmp/x' });

  assert.deepEqual(done.map((d) => d.id), ['good']);
  assert.deepEqual(failed, [{ id: 'missing', error: 'no such submission' }]);
  assert.deepEqual(deleted, ['good'], 'only the one that archived cleanly was deleted');
});

test('an export that fails leaves that submission alone', async (t) => {
  // The order that matters: export, verify, THEN delete. A delete that ran on a
  // failed export would be the one unrecoverable bug in this feature.
  t.mock.method(models.Submission, 'findByPk', async (id) => ({ id, manuscriptId: 'M1' }));
  t.mock.method(archive, 'exportSubmission', async () => { throw new Error('disk full'); });
  let deletes = 0;
  t.mock.method(archive, 'deleteSubmission', async () => { deletes += 1; });

  const { done, failed } = await retention.archiveAndDelete(['a'], { outDir: '/tmp/x' });

  assert.deepEqual(done, []);
  assert.match(failed[0].error, /disk full/);
  assert.equal(deletes, 0);
});

test('the archive is read back before anything is deleted', async (t) => {
  // The export just wrote it, so re-reading looks redundant. It is not: it is
  // the only check that the bytes on disk are readable and self-consistent, and
  // it costs a fraction of what it protects.
  t.mock.method(models.Submission, 'findByPk', async (id) => ({ id, manuscriptId: 'M1' }));
  t.mock.method(archive, 'exportSubmission', async () => ({ tables: {} }));
  t.mock.method(archive, 'readArchive', async () => { throw new Error('damaged'); });
  let deletes = 0;
  t.mock.method(archive, 'deleteSubmission', async () => { deletes += 1; });

  const { failed } = await retention.archiveAndDelete(['a'], { outDir: '/tmp/x' });

  assert.match(failed[0].error, /damaged/);
  assert.equal(deletes, 0, 'an archive that will not read back is not a licence to delete');
});

test('a dry run archives and verifies, and deletes nothing', async (t) => {
  t.mock.method(models.Submission, 'findByPk', async (id) => ({ id, manuscriptId: 'M1' }));
  let verified = 0;
  t.mock.method(archive, 'exportSubmission', async () => ({ tables: {} }));
  t.mock.method(archive, 'readArchive', async () => { verified += 1; return {}; });
  let deletes = 0;
  t.mock.method(archive, 'deleteSubmission', async () => { deletes += 1; });

  const { done } = await retention.archiveAndDelete(['a'], { outDir: '/tmp/x', dryRun: true });

  assert.equal(verified, 1, 'a dry run that skipped the verification would check nothing');
  assert.equal(deletes, 0);
  assert.equal(done[0].deleted, false);
});

test('the same id twice is one submission', async (t) => {
  t.mock.method(models.Submission, 'findByPk', async (id) => ({ id, manuscriptId: 'M1' }));
  t.mock.method(archive, 'exportSubmission', async () => ({ tables: {} }));
  t.mock.method(archive, 'readArchive', async () => ({}));
  let deletes = 0;
  t.mock.method(archive, 'deleteSubmission', async () => { deletes += 1; return { rows: {}, objects: 0 }; });

  await retention.archiveAndDelete(['a', 'a', 'a'], { outDir: '/tmp/x' });

  assert.equal(deletes, 1);
});

test('the destructive half takes no criteria at all', () => {
  // Structural, and the whole point. A `project` or `status` option on
  // archiveAndDelete would reintroduce exactly the gap the split closes: the
  // set deleted would be resolved at delete time, not at review time.
  const source = fs.readFileSync(path.join(__dirname, 'retention.service.js'), 'utf-8');
  const signature = source.slice(
    source.indexOf('async function archiveAndDelete'),
    source.indexOf('{', source.indexOf('async function archiveAndDelete'))
  );

  for (const criterion of ['project', 'status', 'userId:', 'untouchedSince', 'createdBefore', 'limit']) {
    assert.ok(!signature.includes(criterion),
      `archiveAndDelete must not accept ${criterion} — ids only`);
  }
  assert.ok(signature.includes('submissionIds'));
});
