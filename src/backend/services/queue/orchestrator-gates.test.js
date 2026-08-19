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
