/**
 * Software Detection Service
 *
 * Detects software/code mentions using Softcite.
 *
 * Three-step pipeline:
 *   1. detectSoftware(pdfBuffer, fileName) → raw Softcite mentions
 *   2. buildKrtItemsSoftware(mentions)     → canonical KrtEntry[]
 *   3. dedupeKrtItems(items, 'software')   → one entry per logical resource
 *
 * Note: the curated enrichment list is no longer applied here — only the
 * Identifier Detection module consults the enrichment lists now.
 */

// Sequelize models are lazy-loaded inside the worker functions below — see
// the matching comment in protocols.service.js for the rationale.
const s3Service = require('../storage/s3.service');
const softciteClient = require('./softcite-client.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const softciteConfig = require('../../config/softcite-api');
const jobQueue = require('../queue/job-queue.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const logger = require('../../utils/logger');

/** Default when Softcite doesn't return a confidence value. */
const DEFAULT_CONFIDENCE = 0.7;

/**
 * Queue software detection as a background job
 */
async function queueSoftwareDetection(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.SOFTWARE_DETECTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.SOFTWARE_DETECTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('Software detection queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

/**
 * Process software detection — runs the external/demo workflow and persists
 * data on the SubmissionJob so downstream suggestion generation can read it.
 */
async function processSoftwareDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: softciteConfig.isConfigured(),
    demoEnabled: process.env.SOFTWARE_DETECTION_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => detectSoftwareForSubmission(submission, jobLogger),
    getDemoData: async () => {
      const demo = demoDataService.getDemoSoftwareMentions(submission.manuscriptId);
      if (!demo || !demo.items?.length) return null;
      // Demo items use the legacy pre-refactor shape (resource_type, name,
      // context, etc.). Run them through the canonical builder + dedupe so
      // the output matches the External path.
      const krt = buildKrtItemsSoftware(demo.items);
      const items = dedupeKrtItems(krt, 'software-demo');
      await jobLogger?.saveRawResponse('demo-software', items);
      return {
        items,
        meta: { totalCount: items.length, uniqueCount: items.length }
      };
    },
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.SOFTWARE_DETECTION, submission.currentRound || 1, result);
  return result;
}

/**
 * Worker entry point: Softcite + dedupe.
 */
async function detectSoftwareForSubmission(submission, jobLogger) {
  const { File } = require('../../models');
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const pdfFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.PDF, round },
    order: [['version', 'DESC']]
  });
  if (!pdfFile) throw new Error('No PDF file found for software detection');

  jobLogger?.log('download_pdf', 'Downloading PDF from S3', { fileName: pdfFile.fileName });
  const pdfBuffer = await s3Service.downloadFile(pdfFile.s3Key);

  // ── Step 1: detect (Softcite)
  jobLogger?.log('softcite_start', 'Sending PDF to Softcite API');
  const { resources: rawMentions, softciteMs } = await detectSoftware(pdfBuffer, pdfFile.fileName);
  jobLogger?.log('softcite_done', 'Softcite detection complete', {
    rawMentionCount: rawMentions.length, durationMs: softciteMs
  });
  await jobLogger?.saveRawResponse('softcite-response', rawMentions);

  // ── Step 2: buildKrtItems
  const krtItems = buildKrtItemsSoftware(rawMentions);

  // ── Step 3: dedupe
  const items = dedupeKrtItems(krtItems, 'software-softcite');

  return {
    items,
    meta: {
      rawMentionCount: rawMentions.length,
      uniqueCount: items.length,
      softciteMs,
      totalMs: Date.now() - startTime
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure-ish, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Softcite call. Returns the raw mentions as Softcite emitted them.
 * No DB, no S3 (caller passes the PDF buffer).
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @returns {Promise<{ resources: object[], softciteMs: number }>}
 */
async function detectSoftware(pdfBuffer, fileName) {
  const { mentions, durationMs } = await softciteClient.detectSoftware(pdfBuffer, fileName);
  return { resources: mentions, softciteMs: durationMs };
}

/**
 * Step 2: raw Softcite mentions (or legacy demo items) → canonical KrtEntry[].
 *
 * resourceName uses the normalized form when Softcite provides one (it's the
 * cleaned tool name that enrichment matches against). Detector-specific
 * Softcite fields — context (the in-paper sentence), version, creator, the
 * non-normalized name — live on detectorMeta.
 *
 * Pure function.
 *
 * @param {object[]} rawItems
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsSoftware(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map(m => {
    // Softcite shape uses `name`/`normalizedName`/`url`. Legacy demo data uses
    // the post-build shape with `resource_type`/`resourceType`. Be permissive
    // on input so both paths produce the same canonical output.
    const resourceName = m.normalizedName || m.resourceName || m.name || '';
    const resourceType = m.resource_type || m.resourceType || 'Software/code';
    const source = m.source || m.url || '';
    return {
      resourceType,
      resourceName,
      identifier: m.identifier || '',
      source,
      newReuse: m.newReuse || m.new_reuse || '',
      origin: 'softcite',
      confidence: typeof m.confidence === 'number' ? m.confidence : DEFAULT_CONFIDENCE,
      // Per ASAP request, do NOT push Softcite's context blurb into user-
      // facing ADDITIONAL INFORMATION. The blurb is preserved on
      // detectorMeta.context for the internal Softcite Detection panel.
      additionalInformation: '',
      detectorMeta: {
        // Preserve the unnormalized Softcite name so the UI can show it if the
        // normalized form is less recognizable.
        softciteName: m.name || '',
        normalizedName: m.normalizedName || '',
        version: m.version || '',
        creator: m.creator || '',
        // The Softcite Detection panel reads `context` directly; preserve
        // the raw Softcite context blurb alongside additionalInformation so
        // both consumers (panel + downstream enrichment) have what they need.
        additionalInformation: m.additionalInformation || m.context || '',
        context: m.context || ''
      }
    };
  });
}

/**
 * Persist helper output's data on the SubmissionJob so downstream suggestion
 * generation can read it via SubmissionJob.getLatest().
 */
async function persistJobData(submissionId, jobType, round, helperResult) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data: helperResult.data };
    job.changed('result', true);
    await job.save();
  }
}

/**
 * Get software mentions for a submission
 */
async function getSoftwareMentions(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SOFTWARE_DETECTION, round);
  return job?.result?.data || null;
}

module.exports = {
  queueSoftwareDetection,
  processSoftwareDetection,
  getSoftwareMentions,
  // Pipeline steps (pure-ish, exported for benchmarks/tests)
  detectSoftware,
  buildKrtItemsSoftware
};
