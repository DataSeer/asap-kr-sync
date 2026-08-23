/**
 * One round, one PDF, one markdown, one KRT.
 *
 * The failure this prevents was silent by construction. Nine services each ran
 * their own `File.findOne({ type }, order: version DESC)`, so "the input" meant
 * whatever was newest at the moment each step happened to run. Replace a file
 * mid-run and the round split in two, with nothing recording that it had.
 *
 * The KRT was worse: nothing restarts when it changes, the detectors are seeded
 * from `krt_data` as each one runs, and PDF Analysis reads `krt_data` again to
 * consolidate. An author editing their table between the two got detections
 * from one version reconciled against another.
 *
 * Run with: node --test src/backend/services/queue/input-freeze.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionInputFreeze, File, KRTData } = require('../../models');
const inputFreeze = require('./input-freeze.service');
const { INPUT_KINDS } = inputFreeze;

const SUB = 'sub-1';

/** A File row as the pipeline sees it. */
const file = (over = {}) => ({
  id: 'file-v2', version: 2, s3Key: 'k/v2.pdf', size: 1234, ...over
});

/**
 * Stand in for the freeze table with an in-memory store, so the rules can be
 * exercised without a database. `rows` is keyed by input kind.
 */
function fakeStore(t, rows = new Map()) {
  t.mock.method(SubmissionInputFreeze, 'findOne', async ({ where }) =>
    rows.get(where.inputKind) || null);

  t.mock.method(SubmissionInputFreeze, 'create', async (attrs) => {
    if (rows.has(attrs.inputKind)) {
      const err = new Error('duplicate');
      err.name = 'SequelizeUniqueConstraintError';
      throw err;
    }
    rows.set(attrs.inputKind, { ...attrs });
    return rows.get(attrs.inputKind);
  });

  t.mock.method(SubmissionInputFreeze, 'destroy', async ({ where }) => {
    const kinds = where.inputKind?.[Object.getOwnPropertySymbols(where.inputKind)[0]]
      || where.inputKind
      || [...rows.keys()];
    let n = 0;
    for (const kind of (Array.isArray(kinds) ? kinds : [kinds])) {
      if (rows.delete(kind)) n++;
    }
    return n;
  });

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Files
// ─────────────────────────────────────────────────────────────────────────────

test('the first reader freezes the file it found', async (t) => {
  const rows = fakeStore(t);
  t.mock.method(File, 'findOne', async () => file());

  const resolved = await inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.PDF, { jobType: 'markdown_convert' });

  assert.equal(resolved.id, 'file-v2');
  const frozen = rows.get(INPUT_KINDS.PDF);
  assert.equal(frozen.fileId, 'file-v2');
  assert.equal(frozen.fileVersion, 2, 'the version is copied, so the record survives the file');
  assert.equal(frozen.frozenByJobType, 'markdown_convert', 'and who read it first');
});

test('a later reader gets the frozen file, not the newer one', async (t) => {
  // The whole point. A PDF replaced after the round started must not reach a
  // step that runs afterwards — the round would be reading two manuscripts.
  const rows = fakeStore(t, new Map([[INPUT_KINDS.PDF, {
    inputKind: INPUT_KINDS.PDF, fileId: 'file-v2', fileVersion: 2
  }]]));
  t.mock.method(File, 'findByPk', async (id) => file({ id, version: 2 }));
  const latest = t.mock.method(File, 'findOne', async () => file({ id: 'file-v3', version: 3 }));

  const resolved = await inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.PDF, { jobType: 'software_detection' });

  assert.equal(resolved.id, 'file-v2');
  assert.equal(latest.mock.callCount(), 0, 'it must not even look at what is newest');
  assert.equal(rows.size, 1, 'and it does not re-freeze');
});

test('a round with no such file yet resolves to nothing, and freezes nothing', async (t) => {
  // Steps guard on this themselves ("No PDF file found for …"). Freezing a null
  // would pin the round to the absence of a file.
  const rows = fakeStore(t);
  t.mock.method(File, 'findOne', async () => null);

  const resolved = await inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.PDF, { jobType: 'markdown_convert' });

  assert.equal(resolved, null);
  assert.equal(rows.size, 0);
});

test('a frozen file that has been deleted is an error, not a silent substitution', async (t) => {
  // Falling back to the latest would answer a different question and look like
  // success — exactly the failure this service exists to prevent.
  fakeStore(t, new Map([[INPUT_KINDS.PDF, {
    inputKind: INPUT_KINDS.PDF, fileId: 'gone', fileVersion: 2
  }]]));
  t.mock.method(File, 'findByPk', async () => null);
  const latest = t.mock.method(File, 'findOne', async () => file({ id: 'file-v3' }));

  await assert.rejects(
    () => inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.PDF, { jobType: 'software_detection' }),
    /no longer exists/
  );
  assert.equal(latest.mock.callCount(), 0);
});

test('two steps starting together agree on one file', async (t) => {
  // Detectors are released within milliseconds of each other. Both find no
  // freeze, both try to create one; the unique constraint decides and the loser
  // takes the winner's answer rather than failing.
  const rows = fakeStore(t);
  let nth = 0;
  t.mock.method(File, 'findOne', async () => file({ id: `file-${++nth}`, version: nth }));
  t.mock.method(File, 'findByPk', async (id) => file({ id }));

  const [a, b] = await Promise.all([
    inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.MARKDOWN, { jobType: 'datasets_detection' }),
    inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.MARKDOWN, { jobType: 'materials_detection' })
  ]);

  assert.equal(rows.size, 1, 'one freeze, whoever won');
  assert.ok(a && b);
});

test('the kinds are separate — freezing the PDF says nothing about the markdown', async (t) => {
  const rows = fakeStore(t);
  t.mock.method(File, 'findOne', async ({ where }) =>
    file({ id: `f-${where.type}`, version: 1 }));

  await inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.PDF, { jobType: 'markdown_convert' });
  await inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.MARKDOWN, { jobType: 'datasets_detection' });

  assert.equal(rows.size, 2);
});

test('an input kind that is not a file is refused', async (t) => {
  fakeStore(t);
  await assert.rejects(
    () => inputFreeze.resolveFile(SUB, 1, INPUT_KINDS.KRT),
    /not a file input/
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The KRT — held by value, because the rows ARE the editing surface
// ─────────────────────────────────────────────────────────────────────────────

const krtRow = (id, name) => ({ toJSON: () => ({ id, resourceName: name, resourceType: 'Dataset' }) });

test('the first detector snapshots the table', async (t) => {
  const rows = fakeStore(t);
  t.mock.method(KRTData, 'findAll', async () => [krtRow('r1', 'GEO'), krtRow('r2', 'Zenodo')]);

  const resolved = await inputFreeze.resolveKrtRows(SUB, 1, { jobType: 'datasets_detection' });

  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].resourceName, 'GEO');
  assert.equal(rows.get(INPUT_KINDS.KRT).rowCount, 2);
});

test('an author editing the table mid-run does not reach the rest of the pipeline', async (t) => {
  // The failure in full: detections seeded from one table, consolidation
  // reconciled against another, and nothing to show it happened.
  const rows = fakeStore(t, new Map([[INPUT_KINDS.KRT, {
    inputKind: INPUT_KINDS.KRT,
    payload: [{ id: 'r1', resourceName: 'GEO' }],
    rowCount: 1
  }]]));
  const live = t.mock.method(KRTData, 'findAll', async () => [
    krtRow('r1', 'GEO'), krtRow('r2', 'Added while the run was going')
  ]);

  const resolved = await inputFreeze.resolveKrtRows(SUB, 1, { jobType: 'pdf_analysis' });

  assert.equal(resolved.length, 1, 'the run keeps the table it started from');
  assert.equal(live.mock.callCount(), 0);
});

test('a submission with no KRT freezes an empty table rather than nothing', async (t) => {
  // The no-KRT mode is a real mode. Leaving it unfrozen would mean a table
  // uploaded halfway through the round reached only the steps that had not run
  // yet.
  const rows = fakeStore(t);
  t.mock.method(KRTData, 'findAll', async () => []);

  const resolved = await inputFreeze.resolveKrtRows(SUB, 1, { jobType: 'datasets_detection' });

  assert.deepEqual(resolved, []);
  assert.equal(rows.get(INPUT_KINDS.KRT).rowCount, 0, 'frozen as empty, on purpose');
});

// ─────────────────────────────────────────────────────────────────────────────
// Releasing — an input is re-taken only when every reader re-runs
// ─────────────────────────────────────────────────────────────────────────────

const READERS = new Map([
  ['pdf', ['markdown_convert', 'orcid_extraction', 'software_detection']],
  ['markdown', ['das_extraction', 'software_detection', 'datasets_detection']],
  ['krt', ['datasets_detection', 'pdf_analysis']]
]);

test('restarting every reader releases the input', async (t) => {
  const rows = fakeStore(t, new Map([['krt', { inputKind: 'krt' }]]));

  const released = await inputFreeze.releaseForRestart(
    SUB, 1, ['datasets_detection', 'pdf_analysis', 'suggestion_generation'], READERS
  );

  assert.deepEqual(released, ['krt']);
  assert.equal(rows.size, 0);
});

test('restarting SOME readers does not', async (t) => {
  // The siblings keep results built from the frozen markdown. Re-freezing would
  // hand the restarted step a different document from theirs — the split this
  // service exists to prevent, arriving through the repair path.
  const rows = fakeStore(t, new Map([['markdown', { inputKind: 'markdown' }]]));

  const released = await inputFreeze.releaseForRestart(SUB, 1, ['datasets_detection'], READERS);

  assert.deepEqual(released, []);
  assert.equal(rows.size, 1);
});

test('a restart releases exactly the inputs it covers, not the others', async (t) => {
  const rows = fakeStore(t, new Map([
    ['pdf', { inputKind: 'pdf' }],
    ['markdown', { inputKind: 'markdown' }],
    ['krt', { inputKind: 'krt' }]
  ]));

  const released = await inputFreeze.releaseForRestart(
    SUB, 1,
    ['das_extraction', 'software_detection', 'datasets_detection', 'pdf_analysis'],
    READERS
  );

  assert.deepEqual(released.sort(), ['krt', 'markdown'],
    'markdown and krt have all their readers in the restart; the PDF does not');
  assert.ok(rows.has('pdf'), 'the PDF freeze survives — orcid_extraction still holds it');
});

test('an input nothing reads is never released', async (t) => {
  const readers = new Map([['pdf', []]]);
  const rows = fakeStore(t, new Map([['pdf', { inputKind: 'pdf' }]]));

  const released = await inputFreeze.releaseForRestart(SUB, 1, ['markdown_convert'], readers);

  assert.deepEqual(released, [], 'an empty reader list would otherwise vacuously match');
  assert.equal(rows.size, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Describing — what lets the app say "this used an earlier version"
// ─────────────────────────────────────────────────────────────────────────────

test('a file replaced since the run is reported as stale', async (t) => {
  t.mock.method(SubmissionInputFreeze, 'findAll', async () => [{
    inputKind: INPUT_KINDS.PDF, fileId: 'file-v2', fileVersion: 2, frozenAt: new Date(), frozenByJobType: 'markdown_convert'
  }]);
  t.mock.method(File, 'findOne', async () => file({ id: 'file-v3', version: 3 }));

  const [pdf] = await inputFreeze.describe(SUB, 1);

  assert.equal(pdf.stale, true);
  assert.equal(pdf.version, 2, 'what the run read');
  assert.equal(pdf.liveVersion, 3, 'and what is there now');
});

test('an untouched file is not', async (t) => {
  t.mock.method(SubmissionInputFreeze, 'findAll', async () => [{
    inputKind: INPUT_KINDS.PDF, fileId: 'file-v2', fileVersion: 2, frozenAt: new Date()
  }]);
  t.mock.method(File, 'findOne', async () => file({ id: 'file-v2', version: 2 }));

  const [pdf] = await inputFreeze.describe(SUB, 1);

  assert.equal(pdf.stale, false);
});

test('rows added to the KRT since the run are reported', async (t) => {
  t.mock.method(SubmissionInputFreeze, 'findAll', async () => [{
    inputKind: INPUT_KINDS.KRT, rowCount: 12, frozenAt: new Date()
  }]);
  t.mock.method(KRTData, 'count', async () => 14);

  const [krt] = await inputFreeze.describe(SUB, 1);

  assert.equal(krt.stale, true);
  assert.equal(krt.liveRowCount, 14);
});

test('an edited cell is NOT claimed as unchanged', async (t) => {
  // A count cannot see an edit, and this is the honest limit of it: `stale`
  // means "rows were added or removed", never "nothing has changed". Anything
  // stronger would be a claim the data does not support.
  t.mock.method(SubmissionInputFreeze, 'findAll', async () => [{
    inputKind: INPUT_KINDS.KRT, rowCount: 12, frozenAt: new Date()
  }]);
  t.mock.method(KRTData, 'count', async () => 12);

  const [krt] = await inputFreeze.describe(SUB, 1);

  assert.equal(krt.stale, false);
  assert.equal(krt.rowCount, 12);
  assert.equal(krt.liveRowCount, 12, 'both counts are reported, so a reader can judge');
});
