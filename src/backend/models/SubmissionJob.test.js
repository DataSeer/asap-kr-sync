/**
 * How the pipeline decides which row of a job type is the CURRENT one.
 *
 * `getForSubmission` keeps the newest row per type and drops the rest. Every
 * caller trusts that — the orchestrator's advancement, the jobs API, the cancel
 * signal — so "newest wins" is load-bearing rather than a convenience.
 *
 * It is also how a real wrong answer stayed hidden: a second `pdf_analysis` row
 * inserted 10 ms after the pipeline's own ran early, won the newest-wins
 * contest, and the genuine row sat in `waiting` behind it while the run
 * reported complete. The fix was to stop creating the second row; these tests
 * pin the dedup that made it invisible, so the consequences of a duplicate stay
 * understood rather than rediscovered.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SubmissionJob } = require('./index');

const at = (iso) => new Date(iso);

/**
 * Rows as findAll returns them: newest first, since the query orders DESC.
 *
 * `getForSubmission` queries twice — an id/type/createdAt index over the
 * submission, then the winning ids — so the fake answers both shapes. A fake
 * that ignored `where.id` would hand back every row to the second query and
 * quietly re-introduce the duplicate these tests exist to pin.
 */
function mockFindAll(t, rows) {
  t.mock.method(SubmissionJob, 'findAll', async ({ where } = {}) => {
    let out = rows;
    if (where.id !== undefined) {
      const wanted = new Set(Array.isArray(where.id) ? where.id : [where.id]);
      out = out.filter((r) => wanted.has(r.id));
    } else {
      out = out.filter((r) => r.submissionId === where.submissionId);
      if (where.round !== undefined) out = out.filter((r) => r.round === where.round);
    }
    return [...out].sort((a, b) => b.createdAt - a.createdAt);
  });
}

const job = (over) => ({
  submissionId: 'sub-1', round: 1, status: 'complete',
  createdAt: at('2026-08-20T00:00:00Z'), ...over
});

test('one row per job type survives, and it is the newest', async (t) => {
  mockFindAll(t, [
    job({ id: 'old', jobType: 'pdf_analysis', status: 'waiting', createdAt: at('2026-08-20T00:00:00Z') }),
    job({ id: 'new', jobType: 'pdf_analysis', status: 'complete', createdAt: at('2026-08-20T00:00:01Z') })
  ]);

  const jobs = await SubmissionJob.getForSubmission('sub-1', 1);

  assert.equal(jobs.length, 1, 'a duplicated type must collapse to one row');
  assert.equal(jobs[0].id, 'new');
});

test('a ten-millisecond gap is enough to decide it', async (t) => {
  // Not hypothetical: this is the margin the duplicate row actually won by.
  mockFindAll(t, [
    job({ id: 'pipeline-row', jobType: 'pdf_analysis', status: 'waiting', createdAt: at('2026-08-20T00:00:00.191Z') }),
    job({ id: 'rival-row', jobType: 'pdf_analysis', status: 'complete', createdAt: at('2026-08-20T00:00:00.201Z') })
  ]);

  const [current] = await SubmissionJob.getForSubmission('sub-1', 1);

  assert.equal(current.id, 'rival-row');
  assert.equal(current.status, 'complete',
    'the older `waiting` row is invisible to every caller — which is why it stalled silently');
});

test('different job types are all kept', async (t) => {
  mockFindAll(t, [
    job({ id: 'a', jobType: 'markdown_convert' }),
    job({ id: 'b', jobType: 'datasets_detection' }),
    job({ id: 'c', jobType: 'pdf_analysis' })
  ]);

  const jobs = await SubmissionJob.getForSubmission('sub-1', 1);

  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((j) => j.jobType).sort(),
    ['datasets_detection', 'markdown_convert', 'pdf_analysis']
  );
});

test('rounds do not bleed into one another', async (t) => {
  mockFindAll(t, [
    job({ id: 'r1', jobType: 'pdf_analysis', round: 1, createdAt: at('2026-08-20T00:00:00Z') }),
    job({ id: 'r2', jobType: 'pdf_analysis', round: 2, createdAt: at('2026-08-21T00:00:00Z') })
  ]);

  const [first] = await SubmissionJob.getForSubmission('sub-1', 1);
  const [second] = await SubmissionJob.getForSubmission('sub-1', 2);

  assert.equal(first.id, 'r1', 'a newer round must not answer for an older one');
  assert.equal(second.id, 'r2');
});

test('omitting the round returns the latest across all of them', async (t) => {
  mockFindAll(t, [
    job({ id: 'r1', jobType: 'pdf_analysis', round: 1, createdAt: at('2026-08-20T00:00:00Z') }),
    job({ id: 'r2', jobType: 'pdf_analysis', round: 2, createdAt: at('2026-08-21T00:00:00Z') })
  ]);

  const jobs = await SubmissionJob.getForSubmission('sub-1');

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'r2');
});

test('a submission with no jobs returns an empty list, not undefined', async (t) => {
  mockFindAll(t, []);
  assert.deepEqual(await SubmissionJob.getForSubmission('sub-1', 1), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// isRoundCancelled — the run-level stop signal
// ─────────────────────────────────────────────────────────────────────────────

test('a cancelled job cancels the round', async (t) => {
  mockFindAll(t, [
    job({ id: 'a', jobType: 'markdown_convert' }),
    job({ id: 'b', jobType: 'datasets_detection', status: 'cancelled' })
  ]);

  assert.equal(await SubmissionJob.isRoundCancelled('sub-1', 1), true);
});

test('a restart clears the cancel, even though the cancelled row still exists', async (t) => {
  // The restart adds a newer row rather than editing the old one. Reading raw
  // rows would leave the run cancelled for ever.
  mockFindAll(t, [
    job({ id: 'cancelled', jobType: 'datasets_detection', status: 'cancelled', createdAt: at('2026-08-20T00:00:00Z') }),
    job({ id: 'restarted', jobType: 'datasets_detection', status: 'queued', createdAt: at('2026-08-20T01:00:00Z') })
  ]);

  assert.equal(await SubmissionJob.isRoundCancelled('sub-1', 1), false);
});

test('an untouched round is not cancelled', async (t) => {
  mockFindAll(t, [job({ id: 'a', jobType: 'markdown_convert', status: 'complete' })]);
  assert.equal(await SubmissionJob.isRoundCancelled('sub-1', 1), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// markRetrying vs markFailed — is this error terminal?
// ─────────────────────────────────────────────────────────────────────────────
//
// `failed` is terminal to every reader of these rows, the orchestrator
// included: it treats a `failed` dependency as done. Writing it for an error
// pg-boss is about to retry let a reconciler sweep in the backoff window read
// the dependency as finished and park the dependents in `pending_input`, which
// nothing revisits. Only a manual advance recovered them.

/** A row with just enough of the instance for the two methods under test. */
function instance(over = {}) {
  const r = {
    status: 'processing', errorMessage: null, completedAt: null,
    saves: 0,
    async save() { this.saves++; return this; },
    async reload() { return this; },   // the guards reload before checking
    ...over
  };
  r.markFailed = SubmissionJob.prototype.markFailed.bind(r);
  r.markRetrying = SubmissionJob.prototype.markRetrying.bind(r);
  return r;
}

test('an error that will be retried leaves the job in flight, not failed', async () => {
  const r = instance();

  await r.markRetrying('Gemini 503');

  assert.equal(r.status, 'processing', '`failed` here strands every dependent step');
  assert.equal(r.errorMessage, 'Gemini 503', 'the reason is still worth showing');
  assert.equal(r.completedAt, null, 'nothing completed');
  assert.equal(r.saves, 1);
});

test('the last attempt is terminal and says so', async () => {
  const r = instance();

  await r.markFailed('Gemini 503');

  assert.equal(r.status, 'failed');
  assert.equal(r.errorMessage, 'Gemini 503');
  assert.ok(r.completedAt instanceof Date);
});

test('a retry cannot resurrect a job the user cancelled', async () => {
  // Same rule markFailed already follows: the error is a consequence of the
  // cancel, not something to put back in flight.
  const r = instance({ status: 'cancelled' });

  await r.markRetrying('worker interrupted');

  assert.equal(r.status, 'cancelled');
  assert.equal(r.errorMessage, null);
  assert.equal(r.saves, 0, 'nothing to write');
});

test('markRetrying clears a completedAt left by an earlier attempt', async () => {
  const r = instance({ completedAt: at('2026-08-20T00:00:00Z') });

  await r.markRetrying('transient');

  assert.equal(r.completedAt, null, 'a job in flight has not completed');
});
