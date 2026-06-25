/**
 * PDF Analysis Service — the consolidator.
 *
 * Reads each detection's per-source items from `submissionJob.result.data.items`,
 * dedupes/merges them via mergeDetections, and emits the Generated KRT on its
 * own job result (`pdf_analysis.result.data.items`). The diff-based
 * /suggestions API consumes that to compute what the user is shown.
 *
 * No external API call. No demo path of its own — it's a pure consolidator.
 * (Demo data for the upstream detections still flows through the existing
 * demo-fallback workflow.)
 */

const { Submission, SubmissionJob } = require('../../models');
const pdfAnalysisConfig = require('../../config/pdf-analysis-api');
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { runWithDemoFallback } = require('../demo-fallback.service');
const { mergeDetections } = require('./merge-detections.service');
const { consolidateWithLM } = require('./krt-generation.service');
const logger = require('../../utils/logger');

/**
 * Sources that contribute to the Generated KRT. Order matters only for
 * stability of mergedFrom output (first-seen detector tiebreaks).
 */
const CONTRIBUTOR_SOURCES = [
  { source: 'software_detection', jobType: JOB_TYPES.SOFTWARE_DETECTION },
  { source: 'datasets_detection', jobType: JOB_TYPES.DATASETS_DETECTION },
  { source: 'materials_detection', jobType: JOB_TYPES.MATERIALS_DETECTION },
  { source: 'protocols_detection', jobType: JOB_TYPES.PROTOCOLS_DETECTION },
  { source: 'identifier_detection', jobType: JOB_TYPES.IDENTIFIER_DETECTION }
];

/**
 * Worker entry point.
 *
 * Same signature as every other detection's processX so it slots cleanly into
 * the existing helper/worker pipeline. Returns a helper-shaped result object;
 * the worker layer handles markComplete + service snapshot.
 */
async function processAnalysis(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: pdfAnalysisConfig.isConfigured(),
    demoEnabled: process.env.PDF_ANALYSIS_DEMO_DATA_ENABLED === 'true',
    runExternal: () => buildGeneratedKrt(submission, jobLogger),
    getDemoData: async () => null,    // No source-specific demo — derives from upstream
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.PDF_ANALYSIS, submission.currentRound || 1, result);
  return result;
}

/**
 * Read every contributing detection's items and merge into a single
 * deduplicated list. Result.items is the Generated KRT.
 */
async function buildGeneratedKrt(submission, jobLogger) {
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const contributions = [];
  for (const { source, jobType } of CONTRIBUTOR_SOURCES) {
    const job = await SubmissionJob.getLatest(submissionId, jobType, round);
    const items = job?.result?.data?.items || [];
    if (items.length > 0) {
      contributions.push({ source, items });
    }
  }

  jobLogger?.log('merge_start', 'Merging detection results', {
    contributorCount: contributions.length,
    totalItems: contributions.reduce((n, c) => n + c.items.length, 0)
  });

  // Step a: regroup + coarse-dedup every detection's items (keeps detectedBy
  // provenance per merged resource).
  const candidates = mergeDetections(contributions);

  // Step b: an LM consolidates the candidates into the final Generated KRT,
  // attaching a `reason` per line (kept/merged/dropped). Falls back to the
  // rule-based candidates when the LM isn't configured or errors.
  const { items: generatedKrt, dropped, usedLM, rawResponse } = await consolidateWithLM(candidates, jobLogger);
  if (rawResponse) {
    await jobLogger?.saveRawResponse('krt-generation', rawResponse, { extension: '.md', mimeType: 'text/markdown' });
  }
  const multiSource = generatedKrt.filter(g => (g.detectedBy?.length || 0) > 1).length;

  jobLogger?.log('merge_done', 'Generated KRT built', {
    candidateCount: candidates.length,
    resourceCount: generatedKrt.length,
    droppedCount: dropped.length,
    multiSourceCount: multiSource,
    usedLM
  });

  logger.info('PDF Analysis: Generated KRT built', {
    submissionId, round,
    contributorCount: contributions.length,
    resourceCount: generatedKrt.length,
    droppedCount: dropped.length,
    usedLM
  });

  return {
    items: generatedKrt,
    meta: {
      contributorCount: contributions.length,
      contributorSources: contributions.map(c => c.source),
      resourceCount: generatedKrt.length,
      candidateCount: candidates.length,
      droppedCount: dropped.length,
      dropped,
      usedLM,
      multiSourceCount: multiSource,
      totalMs: Date.now() - startTime
    }
  };
}

/**
 * Persist the helper output's data on the SubmissionJob so the diff endpoint
 * can read it via getLatest().
 */
async function persistJobData(submissionId, jobType, round, helperResult) {
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data: helperResult.data };
    job.changed('result', true);
    await job.save();
  }
}

/**
 * Read the Generated KRT for a submission/round (utility for the diff endpoint).
 */
async function getGeneratedKrt(submissionId, round) {
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.PDF_ANALYSIS, round);
  return job?.result?.data?.items || [];
}

module.exports = {
  processAnalysis,
  buildGeneratedKrt,
  getGeneratedKrt,
  CONTRIBUTOR_SOURCES
};
