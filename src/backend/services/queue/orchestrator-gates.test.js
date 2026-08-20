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

test('an empty conversion blocks every step that reads the manuscript', () => {
  const curated = { status: 'step_pdf' };
  for (const jobType of [...DETECTORS, JOB_TYPES.DAS_EXTRACTION, JOB_TYPES.KRT_GROUNDING]) {
    assert.equal(
      orchestrator.isGateBlocked(jobType, curated, jobs(convertJob(0))),
      'markdown_ready',
      `${jobType} must not run on an empty document`
    );
  }
});

test('text present and KRT curated: nothing is gated', () => {
  const curated = { status: 'step_pdf' };
  for (const jobType of [...DETECTORS, JOB_TYPES.DAS_EXTRACTION, JOB_TYPES.KRT_GROUNDING]) {
    assert.equal(orchestrator.isGateBlocked(jobType, curated, jobs(convertJob(120_000))), null, jobType);
  }
});

test('the KRT gate holds the detectors while the author is still curating', () => {
  const editing = { status: 'step_krt' };
  const ready = jobs(convertJob(120_000));
  for (const jobType of DETECTORS) {
    assert.equal(orchestrator.isGateBlocked(jobType, editing, ready), 'krt_curated', jobType);
  }
  // DAS reads no KRT, so it runs as soon as there is text.
  assert.equal(orchestrator.isGateBlocked(JOB_TYPES.DAS_EXTRACTION, editing, ready), null);
});

test('the missing text is reported before the KRT step, not after', () => {
  // Both gates unsatisfied: the actionable one is the conversion, because the
  // KRT gate clears by itself and this one does not.
  assert.equal(
    orchestrator.isGateBlocked(JOB_TYPES.MATERIALS_DETECTION, { status: 'step_krt' }, jobs(convertJob(0))),
    'markdown_ready'
  );
});

test('conversion still running is not "no text" — the dependency check holds the step', () => {
  const running = { jobType: JOB_TYPES.MARKDOWN_CONVERT, status: 'processing', result: null };
  assert.equal(
    orchestrator.isGateBlocked(JOB_TYPES.MATERIALS_DETECTION, { status: 'step_pdf' }, jobs(running)),
    null
  );
});

test('markdown_convert itself is never gated on its own output', () => {
  assert.equal(
    orchestrator.isGateBlocked(JOB_TYPES.MARKDOWN_CONVERT, { status: 'step_krt' }, jobs(convertJob(0))),
    null
  );
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
