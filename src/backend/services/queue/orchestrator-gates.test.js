/**
 * The pipeline gates, tested against the shape the jobs actually have.
 *
 * The markdown gate exists because of a real run: conversion failed, the job
 * still completed with `markdownLength: 0`, and every downstream module then
 * reported zero findings — indistinguishable, to a reader, from a manuscript
 * that genuinely mentions nothing.
 */

const test = require('node:test');
const assert = require('node:assert');

const orchestrator = require('./orchestrator.service');
const { JOB_TYPES } = require('../../config/constants');

const convertJob = (markdownLength) => ({
  jobType: JOB_TYPES.MARKDOWN_CONVERT,
  status: 'complete',
  result: { data: { markdownLength } }
});

const jobs = (convert) => new Map([[JOB_TYPES.MARKDOWN_CONVERT, convert]]);

const DETECTORS = [
  JOB_TYPES.SOFTWARE_DETECTION,
  JOB_TYPES.DATASETS_DETECTION,
  JOB_TYPES.MATERIALS_DETECTION,
  JOB_TYPES.PROTOCOLS_DETECTION,
  JOB_TYPES.IDENTIFIER_DETECTION
];

// ── the manuscript text ─────────────────────────────────────────────────────
//
// This WAS a gate — `markdown_ready`, repeated on the seven steps that read the
// manuscript. It is now a property of the conversion itself (`produced` on the
// step), which is where it belonged: "did the conversion produce usable text"
// is a fact about the conversion, not something each of its readers should be
// trusted to remember to ask.
//
// The protection is the same and reaches further. A conversion that produced
// nothing now raises an ISSUE — a person is asked — and once they decide, the
// steps that required it are SKIPPED rather than left waiting for ever.

test('an empty conversion has produced nothing, whatever its status says', () => {
  // The run this was written for: conversion failed, the job still completed
  // with `markdownLength: 0`, and every downstream module reported zero
  // findings — indistinguishable, to a reader, from a manuscript that genuinely
  // mentions nothing.
  assert.equal(orchestrator.producedOutput(convertJob(0)), false);
  assert.equal(orchestrator.producedOutput(convertJob(120_000)), true);
});

test('and it is an issue, so a person is asked before anything reads it', () => {
  const { needed, kind } = orchestrator.issueOf(convertJob(0));

  assert.equal(needed, true);
  assert.equal(kind, 'unusable', 'nobody errored — there is simply nothing to read');
});

test('a conversion with text raises nothing', () => {
  assert.equal(orchestrator.issueOf(convertJob(120_000)).needed, false);
});

test('a FAILED conversion produced nothing either', () => {
  // The route that used to skip the gate: it only ever inspected `complete`
  // rows, while the dependency check counted `failed` as terminal — so a
  // conversion that errored outright released every detector to read a
  // manuscript that does not exist.
  const failed = { jobType: JOB_TYPES.MARKDOWN_CONVERT, status: 'failed', result: null };

  assert.equal(orchestrator.producedOutput(failed), false);
  assert.equal(orchestrator.issueOf(failed).kind, 'failure');
});

test('nor a cancelled one', () => {
  const cancelled = { jobType: JOB_TYPES.MARKDOWN_CONVERT, status: 'cancelled', result: null };

  assert.equal(orchestrator.producedOutput(cancelled), false);
});

test('a conversion still running has not produced nothing — it has produced nothing YET', () => {
  // The distinction the ordering in tryAdvanceStep protects: a dependency that
  // is still working must hold its dependents, not skip them.
  const running = { jobType: JOB_TYPES.MARKDOWN_CONVERT, status: 'processing', result: null };

  assert.equal(orchestrator.producedOutput(running), false, 'no output yet');
  assert.equal(orchestrator.issueOf(running).needed, false, 'but nothing to decide about');
});

test('the manuscript is required by everything that reads it', () => {
  // The declaration that turns "produced nothing" into "cannot run", and the
  // reason those steps are skipped rather than run into a failure.
  for (const jobType of [...DETECTORS, JOB_TYPES.DAS_EXTRACTION, JOB_TYPES.KRT_GROUNDING]) {
    const step = orchestrator.PIPELINE.find((x) => x.jobType === jobType);
    assert.ok(
      !(step.optional || []).includes(JOB_TYPES.MARKDOWN_CONVERT),
      `${jobType} cannot run without the manuscript text`
    );
  }
});

test('the KRT gate holds the detectors while the author is still curating', () => {
  // Submission STATE, not a dependency — which is why it stayed a gate.
  for (const jobType of DETECTORS) {
    assert.equal(
      orchestrator.isGateBlocked(jobType, { status: 'step_krt' }, jobs(convertJob(120_000))),
      'krt_curated',
      jobType
    );
  }
});

test('and lets them go once the author moves on', () => {
  for (const jobType of DETECTORS) {
    assert.equal(
      orchestrator.isGateBlocked(jobType, { status: 'step_pdf' }, jobs(convertJob(120_000))),
      null,
      jobType
    );
  }
});

// ── the Availability Statement check ────────────────────────────────────────
// Two conditions in one gate. Either alone runs the check pointlessly: too
// early, against a table the author is still editing; or with no statement, an
// LM call against an empty string.

const A_REAL_STATEMENT = 'Data are available at Zenodo.';
// No default parameter: one of the cases below passes `undefined` on purpose,
// and a default would quietly turn it into the good statement.
const withDas = (status, das) => ({ status, dataAvailabilityStatement: das });

test('the DAS check waits until the submission reaches the Availability step', () => {
  for (const status of ['draft', 'step_krt', 'step_pdf', 'step_review']) {
    assert.equal(
      orchestrator.isGateBlocked(JOB_TYPES.DAS_SUGGESTIONS, withDas(status, A_REAL_STATEMENT), new Map()),
      'availability_ready',
      `${status} is before the step the check is about`
    );
  }
});

test('and runs from that step onward', () => {
  for (const status of ['step_as', 'step_report', 'completed']) {
    assert.equal(
      orchestrator.isGateBlocked(JOB_TYPES.DAS_SUGGESTIONS, withDas(status, A_REAL_STATEMENT), new Map()),
      null,
      `${status} has reached the Availability step`
    );
  }
});

test('it does not run without a statement to check', () => {
  // Extraction is fail-soft and always persists something, so "there is a row"
  // is not "there is a statement".
  for (const das of ['', '   ', null, undefined, 'Not found']) {
    assert.equal(
      orchestrator.isGateBlocked(JOB_TYPES.DAS_SUGGESTIONS, withDas('step_as', das), new Map()),
      'availability_ready',
      `${JSON.stringify(das)} is not a statement to check`
    );
  }
});

test('a statement typed in by hand releases it', () => {
  // The extraction result still says "not found" and always will, so the gate
  // reads the submission's current statement instead.
  assert.equal(
    orchestrator.isGateBlocked(JOB_TYPES.DAS_SUGGESTIONS, withDas('step_as', 'I wrote this myself.'), new Map()),
    null
  );
});

test('the check is gated on its own step, not on the KRT or the manuscript', () => {
  // It reads the author's table and their statement — neither the converted
  // text nor KRT validation is its business, and inheriting those gates would
  // stall it for reasons that have nothing to do with it.
  const step = orchestrator.PIPELINE.find((s) => s.jobType === JOB_TYPES.DAS_SUGGESTIONS);
  assert.deepEqual(step.gate, ['availability_ready']);
});
