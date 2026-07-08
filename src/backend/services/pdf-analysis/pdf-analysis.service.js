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

const { Submission, SubmissionJob, KRTData } = require('../../models');
const pdfAnalysisConfig = require('../../config/pdf-analysis-api');
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { runWithDemoFallback } = require('../demo-fallback.service');
const { mergeDetections } = require('./merge-detections.service');
const { consolidateWithLM } = require('./krt-generation.service');
const { normalizeName, identifiersMatch, computeDedupKey } = require('./identifier-normalize.service');
const logger = require('../../utils/logger');

/**
 * Seed-retention invariant (issue #1): the Generated KRT MUST contain every
 * author KRT item. The detection modules are seeded with author data and are
 * meant to keep it, but the LM consolidation sometimes drops an author-provided
 * resource anyway — observed: the datasets consolidation dropping ~1 in 5 author
 * dataset seeds it mistook for assay readouts, even ones deposited with a Zenodo
 * DOI. Since the Generated KRT feeds the AI-suggestion comparison, a dropped
 * author item can no longer be enriched (and, in the eval, looks un-detected).
 *
 * This guarantees, in code, that no author item is lost: any author row not
 * already represented in the generated list (matched by identifier or normalized
 * name) is appended, tagged `carriedFromAuthorKrt` so downstream can tell it
 * apart from a fresh detection and the comparison won't re-add it.
 *
 * @param {object[]} generatedKrt - consolidated detection items
 * @param {object[]} authorRows - author KRT rows (resourceType/Name/source/identifier/newReuse)
 * @returns {{ items: object[], carried: object[] }}
 */
function reconcileWithAuthorKrt(generatedKrt, authorRows) {
  const items = [...generatedKrt];
  const isRepresented = (row) => {
    const rn = normalizeName(row.resourceName);
    return items.some(g =>
      (g.identifier && row.identifier && identifiersMatch(g.identifier, row.identifier)) ||
      (!!rn && normalizeName(g.resourceName) === rn)
    );
  };
  const carried = [];
  for (const row of authorRows || []) {
    if (!row?.resourceName && !row?.identifier) continue; // blank row
    if (isRepresented(row)) continue;
    const base = {
      resourceType: row.resourceType || '', resourceName: row.resourceName || '',
      sourceUrl: row.source || '', identifier: row.identifier || '', newReuse: row.newReuse || ''
    };
    const carriedItem = {
      ...base,
      dedupKey: computeDedupKey(base),
      detectedBy: [{ source: 'author_krt' }],
      confidence: 1,
      carriedFromAuthorKrt: true,
      reason: 'Carried over from the author KRT — not re-detected in the PDF (seed retention)'
    };
    items.push(carriedItem);
    carried.push(carriedItem);
  }
  return { items, carried };
}

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
  const consolidated = await consolidateWithLM(candidates, jobLogger);
  const { dropped, usedLM, rawResponse } = consolidated;
  if (rawResponse) {
    await jobLogger?.saveRawResponse('krt-generation', rawResponse, { extension: '.md', mimeType: 'text/markdown' });
  }

  // Seed retention: guarantee every author KRT item survives into the Generated
  // KRT, even if the LM consolidation dropped it (see reconcileWithAuthorKrt).
  const authorRows = await KRTData.findAll({ where: { submissionId, round } });
  const { items: generatedKrt, carried } = reconcileWithAuthorKrt(consolidated.items, authorRows);
  if (carried.length) {
    jobLogger?.log('seed_retention', 'Carried author KRT items the consolidation did not reproduce', { carriedCount: carried.length });
    logger.info('PDF Analysis: carried author KRT items into Generated KRT (seed retention)', {
      submissionId, round, carriedCount: carried.length
    });
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
      carriedCount: carried.length,
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
  reconcileWithAuthorKrt,
  CONTRIBUTOR_SOURCES
};
