'use strict';

/**
 * Software detection runs two engines and unions them: Softcite (a NER service
 * reading the PDF, good at tool NAMES in prose) and an LM pass reading the
 * converted markdown (good at what a name recogniser structurally cannot see —
 * `RRID:SCR_…`, GitHub links, parenthetical packages).
 *
 * The LM side has always been fail-soft. The Softcite side was not: one
 * unguarded call meant a Softcite outage produced ZERO software rows for a
 * manuscript the LM pass could still read. Seen live on TV1-000430-007 —
 * "Softcite error: Service error", 0 rows, job recorded complete.
 *
 * Three rules, and the third is the one that matters most:
 *   1. Softcite down  → the LM pass carries the run.
 *   2. LM unavailable → Softcite carries the run.
 *   3. BOTH down      → the run FAILS. An empty result presented as success
 *      reads as "this manuscript mentions no software", which is a claim
 *      nothing made.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const softwareService = require('./software.service');
const softciteClient = require('./softcite-client.service');
const softwareLm = require('./software-lm.service');
const s3Service = require('../storage/s3.service');
const models = require('../../models');
const { FILE_TYPES } = require('../../config/constants');
const inputFreeze = require('../queue/input-freeze.service');

const SUBMISSION = { id: 'sub-1', currentRound: 1 };

const MARKDOWN = 'We analysed the data with CellRanger (RRID:SCR_017344) and custom scripts.';

/** A Softcite mention, in the shape the client returns (see software.service.test.js). */
const mention = (name) => ({
  name, normalizedName: name, url: 'https://example.org', version: '1.0',
  creator: 'Someone', confidence: 0.9, context: `We used ${name}.`
});

/** What the LM pass returns before the canonical builder runs. */
const lmResource = (name) => ({
  resourceName: name, resourceType: 'Software/code', identifier: 'RRID:SCR_017344',
  source: 'Vendor', newReuse: 'reuse', additionalInformation: '',
  evidence: { quote: 'We analysed the data with CellRanger' }
});

/**
 * Wire every seam the detection path touches. Each test then overrides only
 * the engine it is about.
 */
function harness(t, { softcite, lmEnabled = true, hasMarkdown = true, lmResources = [] } = {}) {
  // Detection reads the round's FROZEN documents, so the seam is the freeze
  // service rather than the File model: every step in a run is handed the same
  // PDF and the same markdown, whatever has been uploaded since.
  t.mock.method(inputFreeze, 'resolveFile', async (_sub, _round, inputKind) => {
    if (inputKind === inputFreeze.INPUT_KINDS.PDF) return { fileName: 'p.pdf', s3Key: 'pdf-key', id: 'f1' };
    if (inputKind === inputFreeze.INPUT_KINDS.MARKDOWN) {
      return hasMarkdown ? { fileName: 'p.md', s3Key: 'md-key', id: 'f2' } : null;
    }
    return null;
  });
  t.mock.method(s3Service, 'downloadFile', async () => Buffer.from(MARKDOWN, 'utf-8'));

  t.mock.method(softciteClient, 'detectSoftware', async () => {
    if (softcite instanceof Error) throw softcite;
    return { mentions: softcite || [], durationMs: 5 };
  });

  t.mock.method(softwareLm, 'isEnabled', () => lmEnabled);
  t.mock.method(softwareLm, 'detectSoftwareLM', async () => ({
    resources: lmResources, rawResponse: null, promptDigest: { sha256: 'x', bytes: 1 }
  }));
}

test('Softcite down: the LM pass carries the run, and it is marked degraded', async (t) => {
  harness(t, { softcite: new Error('Softcite error: Service error'), lmResources: [lmResource('CellRanger')] });

  const result = await softwareService.detectSoftwareForSubmission(SUBMISSION, null);

  assert.ok(result.items.length > 0, 'the LM pass found software; it must not be discarded');
  assert.equal(result.meta.softciteFailed, true);
  assert.match(result.meta.softciteError, /Service error/);
  assert.deepEqual(result.meta.degraded, { engine: 'softcite', error: 'Softcite error: Service error' },
    'the degradation must be declared in the shape demo-fallback turns into `partial`');
});

test('Softcite fine: nothing is marked degraded', async (t) => {
  harness(t, { softcite: [mention('ImageJ')], lmResources: [lmResource('CellRanger')] });

  const result = await softwareService.detectSoftwareForSubmission(SUBMISSION, null);

  assert.equal(result.meta.softciteFailed, false);
  assert.equal(result.meta.softciteError, null);
  assert.equal(result.meta.degraded, undefined, 'a healthy run must not report itself partial');
});

test('LM unavailable: Softcite carries the run, undegraded', async (t) => {
  // The pre-existing direction, re-pinned here so the new guard cannot break it.
  harness(t, { softcite: [mention('ImageJ')], lmEnabled: false });

  const result = await softwareService.detectSoftwareForSubmission(SUBMISSION, null);

  assert.ok(result.items.length > 0);
  assert.equal(result.meta.lmSkippedReason, 'not_configured');
  assert.equal(result.meta.degraded, undefined,
    'a disabled LM pass is a configuration, not a failure');
});

test('both engines down: the run FAILS rather than reporting no software', async (t) => {
  harness(t, { softcite: new Error('Softcite error: Service error'), lmEnabled: false });

  await assert.rejects(
    () => softwareService.detectSoftwareForSubmission(SUBMISSION, null),
    /Service error/,
    'nothing read the manuscript, so there is no answer to report'
  );
});

test('Softcite down and the LM finds nothing: still a failure', async (t) => {
  // The LM ran and returned an empty list. Indistinguishable, from the outside,
  // from "no software in this paper" — but with Softcite dead there is no
  // second opinion, so it is not a result worth standing behind.
  harness(t, { softcite: new Error('Softcite error: Service error'), lmResources: [] });

  await assert.rejects(
    () => softwareService.detectSoftwareForSubmission(SUBMISSION, null),
    /Service error/
  );
});

test('Softcite down and no markdown yet: still a failure', async (t) => {
  harness(t, { softcite: new Error('Softcite error: Service error'), hasMarkdown: false });

  await assert.rejects(
    () => softwareService.detectSoftwareForSubmission(SUBMISSION, null),
    /Service error/
  );
});

/**
 * The other half of the contract: a degradation declared by a service has to
 * survive the wrapper and reach the stored snapshot as `partial`. Tested here
 * because the two halves are useless apart — a service that reports itself
 * degraded into a wrapper that flattens it back to 'done' is no better than
 * not reporting at all.
 */
const { runWithDemoFallback } = require('../demo-fallback.service');

const wrap = (runExternal) => runWithDemoFallback({
  isExternalEnabled: true, demoEnabled: false, runExternal,
  getDemoData: async () => null, isFinalAttempt: true
});

test('a declared degradation reaches the snapshot as `partial`', async () => {
  const out = await wrap(async () => ({
    items: [{ resourceName: 'CellRanger' }],
    meta: { degraded: { engine: 'softcite', error: 'Service error' } }
  }));

  assert.equal(out.status, 'partial', 'not `done` — the run is real AND incomplete');
  assert.equal(out.failReason, 'softcite_failed');
  assert.equal(out.externalError, 'Service error');
  assert.equal(out.data.items.length, 1, 'the rows that WERE found must survive');
});

test('an undegraded run is still plain `done`', async () => {
  const out = await wrap(async () => ({ items: [{ resourceName: 'ImageJ' }], meta: {} }));

  assert.equal(out.status, 'done');
  assert.equal(out.failReason, null);
});

test('an empty-but-healthy run is `done`, not `partial`', async () => {
  // Finding nothing is a perfectly good answer when both engines looked.
  const out = await wrap(async () => ({ items: [], meta: {} }));

  assert.equal(out.status, 'done');
  assert.deepEqual(out.data.items, []);
});

test('a thrown external is still `fail`, and `partial` never masks it', async () => {
  const out = await wrap(async () => { throw new Error('everything is down'); });

  assert.equal(out.status, 'fail');
  assert.equal(out.failReason, 'external_failed_demo_disabled');
});
