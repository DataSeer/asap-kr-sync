/**
 * Job Queue Workers
 *
 * Registers handlers for all background job queues. Each handler:
 *   1. Marks the SubmissionJob as processing.
 *   2. Computes isFinalAttempt from pg-boss retrycount + JOB_CONFIG retryLimit.
 *   3. Calls processX(submissionId, jobLogger, { isFinalAttempt }) — the service
 *      runs the external→demo workflow via demo-fallback.service and returns a
 *      standard { data, source, status, failReason, externalError } object.
 *   4. Generates suggestions when status='done' and items are present.
 *   5. Persists the new service snapshot via markComplete:
 *        service.config  = { state: 'on'|'demo'|'off', enabled, demoEnabled }
 *        service.outcome = { state: 'done'|'fail', source, failReason, externalError }
 *
 * markFailed is reserved for unexpected errors (e.g., DB down, NotFoundError).
 * Workflow-level failures (external exhausted retries, no demo data) reach the
 * handler as a status='fail' result and go through markComplete.
 */

const jobQueue = require('./job-queue.service');
const orchestrator = require('./orchestrator.service');
const { createJobLogger } = require('./job-logger.service');
const { registerRefreshTokenCleanup } = require('../auth/refresh-token-cleanup');
const { configState, isFinalAttempt: helperIsFinalAttempt } = require('../demo-fallback.service');
const logger = require('../../utils/logger');

const dasExtractionConfig = require('../../config/das-extraction-api');
const softciteConfig = require('../../config/softcite-api');
const grobidConfig = require('../../config/grobid-api');
const markdownConfig = require('../../config/pdf-markdown-api');
const datasetsConfig = require('../../config/datasets-detection-api');
const materialsConfig = require('../../config/materials-detection-api');
const protocolsConfig = require('../../config/protocols-detection-api');
const pdfAnalysisConfig = require('../../config/pdf-analysis-api');

/**
 * Per-job-type config readers. Each entry returns the live (env-time) state
 * of the external service and demo flag for a given job type. Centralized
 * here so the rule "what does ON/DEMO/OFF mean for jobType X" lives in one
 * place. Mirrors the per-service env-flag conventions documented in
 * .env.example (some default-on, some default-off — preserved as-is).
 */
const SERVICE_CFG = {
  das_extraction: {
    isExternalEnabled: () => dasExtractionConfig.isConfigured(),
    isDemoEnabled: () => process.env.DAS_EXTRACTION_DEMO_DATA_ENABLED !== 'false'
  },
  pdf_analysis: {
    isExternalEnabled: () => pdfAnalysisConfig.isConfigured(),
    isDemoEnabled: () => process.env.PDF_ANALYSIS_DEMO_DATA_ENABLED === 'true'
  },
  software_detection: {
    isExternalEnabled: () => softciteConfig.isConfigured(),
    isDemoEnabled: () => process.env.SOFTWARE_DETECTION_DEMO_DATA_ENABLED !== 'false'
  },
  orcid_extraction: {
    isExternalEnabled: () => grobidConfig.isConfigured(),
    isDemoEnabled: () => process.env.ORCID_EXTRACTION_DEMO_DATA_ENABLED === 'true'
  },
  markdown_convert: {
    isExternalEnabled: () => markdownConfig.isConfigured(),
    isDemoEnabled: () => process.env.PDF_MARKDOWN_DEMO_DATA_ENABLED !== 'false'
  },
  datasets_detection: {
    isExternalEnabled: () => datasetsConfig.isConfigured(),
    isDemoEnabled: () => process.env.DATASETS_DETECTION_DEMO_DATA_ENABLED !== 'false'
  },
  materials_detection: {
    isExternalEnabled: () => materialsConfig.isConfigured(),
    isDemoEnabled: () => process.env.MATERIALS_DETECTION_DEMO_DATA_ENABLED !== 'false'
  },
  protocols_detection: {
    isExternalEnabled: () => protocolsConfig.isConfigured(),
    isDemoEnabled: () => process.env.PROTOCOLS_DETECTION_DEMO_DATA_ENABLED !== 'false'
  },
  // Identifier detection has no external API and no demo path — it's purely
  // local pattern-matching against the curated enrichment list. Mark it
  // permanently external-enabled so the config snapshot reads `state: 'on'`.
  identifier_detection: {
    isExternalEnabled: () => true,
    isDemoEnabled: () => false
  }
};

/**
 * Read the live config + helper outcome and produce the persisted shape.
 *
 * @param {string} jobType - Key from SERVICE_CFG (matches JOB_TYPES values).
 * @param {{status: string, source: string|null, failReason: string|null, externalError: string|null}} helperResult
 * @returns {{
 *   config: { state: 'on'|'demo'|'off', enabled: boolean, demoEnabled: boolean },
 *   outcome: { state: 'done'|'fail', source: 'external'|'demo'|null,
 *              failReason: string|null, externalError: string|null }
 * }}
 */
function buildServiceSnapshot(jobType, helperResult) {
  const cfg = SERVICE_CFG[jobType];
  const isExternalEnabled = cfg ? cfg.isExternalEnabled() : false;
  const demoEnabled = cfg ? cfg.isDemoEnabled() : false;
  return {
    config: {
      state: configState({ isExternalEnabled, demoEnabled }),
      enabled: isExternalEnabled,
      demoEnabled
    },
    outcome: {
      state: helperResult?.status || 'fail',
      source: helperResult?.source || null,
      failReason: helperResult?.failReason || null,
      externalError: helperResult?.externalError || null
    }
  };
}

/**
 * Compute whether a pg-boss retry attempt is the final one.
 * Reads the configured retryLimit from JOB_CONFIG so we don't hardcode it.
 */
function isFinalAttemptFor(queueName, pgBossJob) {
  const retryLimit = jobQueue.JOB_CONFIG?.[queueName]?.retryLimit ?? 0;
  return helperIsFinalAttempt(pgBossJob, retryLimit);
}

/**
 * Whether the helper result represents a successful run that produced items.
 * Drives both the "detected" status field and whether to generate suggestions.
 */
function isProductive(helperResult) {
  return helperResult?.status === 'done' && (helperResult.data?.items?.length || 0) > 0;
}

/**
 * Look up a SubmissionJob by ID and mark it as processing.
 */
async function getSubmissionJob(submissionJobId, pgBossJob) {
  if (!submissionJobId) return null;
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.findByPk(submissionJobId);
  if (job) {
    await job.markProcessing(pgBossJob?.retrycount || 0);
  }
  return job;
}

/**
 * Load submission and return { submission, manuscriptId, round }
 */
async function loadSubmission(submissionId) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  return {
    submission,
    manuscriptId: submission?.manuscriptId || null,
    round: submission?.currentRound || 1
  };
}

/**
 * After a job finishes (success or failure), advance the pipeline.
 */
async function advancePipeline(submissionId, jobType, round, userId) {
  try {
    await orchestrator.checkAndAdvance(submissionId, jobType, round, userId);
  } catch (err) {
    logger.error('Failed to advance pipeline', {
      submissionId, jobType, error: err.message
    });
  }
}

/**
 * Initialize all job workers
 */
async function initializeWorkers() {
  // PDF Analysis Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.PDF_ANALYSIS,
    async (data, pgBossJob) => {
      const { processAnalysis } = require('../pdf-analysis/pdf-analysis.service');
      const { submissionId, userId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.PDF_ANALYSIS, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting PDF analysis (KRT consolidator)', { isFinalAttempt });

        const result = await processAnalysis(submissionId, jobLogger, { isFinalAttempt });
        jobLogger?.log('complete', 'Generated KRT built', {
          status: result.status, source: result.source,
          resourceCount: result.data?.meta?.resourceCount || 0,
          contributorCount: result.data?.meta?.contributorCount || 0,
          multiSourceCount: result.data?.meta?.multiSourceCount || 0
        });

        // Persist the Generated KRT to S3 so users can inspect it via the
        // job-detail modal's "Raw Responses" download section. Same pattern as
        // every other detection's saveRawResponse call.
        await jobLogger?.saveRawResponse('generated-krt', result.data?.items || []);

        const m = result.data?.meta || {};
        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('pdf_analysis', result),
          counts: {
            resources: m.resourceCount || 0,
            contributors: m.contributorCount || 0,
            multiSource: m.multiSourceCount || 0
          },
          timing: { totalMs: m.totalMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'pdf_analysis', round, userId);
        return { success: true, submissionJobId };
      } catch (error) {
        jobLogger?.log('error', `PDF analysis failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // Only propagate to the pipeline once pg-boss has truly given up. On
        // non-final attempts the retry will overwrite this failure, so
        // signalling dependents now would unblock them prematurely (see
        // DAS_EXTRACTION / pdf_analysis pending_input bug).
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'pdf_analysis', round, userId);
        }
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // DAS Extraction Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.DAS_EXTRACTION,
    async (data, pgBossJob) => {
      const { extractAndSaveDAS } = require('../pdf/pdf.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.DAS_EXTRACTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting DAS extraction', { isFinalAttempt });

        const result = await extractAndSaveDAS(submissionId, jobLogger, { isFinalAttempt });
        jobLogger?.log('complete', isProductive(result) ? 'DAS found' : 'DAS not found', {
          status: result.status, source: result.source,
          dasLength: result.data?.meta?.dasLength || 0
        });

        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('das_extraction', result),
          data: { das: result.data?.meta?.das || null }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'das_extraction', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `DAS extraction failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // Only propagate once pg-boss has truly given up. Advancing here on a
        // transient failure marked DAS as terminal-failed, and pdf_analysis's
        // canAutoAdvance then parked itself in pending_input — a state
        // checkAndAdvance never revisits, so the subsequent successful retry
        // could not unstick it.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'das_extraction', round);
        }
        throw error;
      }
    },
    { concurrency: 2 }
  );

  // Report Generation Worker (no demo workflow — leave alone)
  await jobQueue.registerHandler(
    jobQueue.QUEUES.REPORT_GENERATION,
    async (data, pgBossJob) => {
      const { generateReport } = require('../reports/report.service');
      const { submissionId, type, userId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;

      try {
        jobLogger?.log('start', 'Starting report generation', { type });
        const report = await generateReport(submissionId, type, userId);
        jobLogger?.log('complete', 'Report generated', { reportId: report.id });

        if (submissionJob) await submissionJob.markComplete({ status: { detected: true }, data: { reportId: report.id } });
        await jobLogger?.flush();
        return { success: true, reportId: report.id };
      } catch (error) {
        jobLogger?.log('error', `Report generation failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        throw error;
      }
    },
    { concurrency: 2 }
  );

  // Software Detection Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.SOFTWARE_DETECTION,
    async (data, pgBossJob) => {
      const { processSoftwareDetection } = require('../software/software.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.SOFTWARE_DETECTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting software detection', { isFinalAttempt });

        const result = await processSoftwareDetection(submissionId, jobLogger, { isFinalAttempt });
        jobLogger?.log('detection_complete', 'Software detection complete', {
          status: result.status, source: result.source,
          uniqueCount: result.data?.meta?.uniqueCount || 0
        });

        // Suggestions are no longer generated here. The pdf_analysis worker
        // consolidates every detection's items into the Generated KRT, and
        // the /suggestions API computes the diff at read time.
        const m = result.data?.meta || {};
        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('software_detection', result),
          counts: {
            total: m.rawMentionCount || 0, unique: m.uniqueCount || 0,
            enriched: m.enrichedCount || 0
          },
          timing: { totalMs: m.totalMs || 0, apiMs: m.softciteMs || 0, enrichMs: m.enrichMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'software_detection', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `Software detection failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'software_detection', round);
        }
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // ORCID Extraction Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.ORCID_EXTRACTION,
    async (data, pgBossJob) => {
      const { processOrcidExtraction } = require('../orcid/orcid.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.ORCID_EXTRACTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting ORCID extraction', { isFinalAttempt });

        const result = await processOrcidExtraction(submissionId, jobLogger, { isFinalAttempt });
        const m = result.data?.meta || {};
        jobLogger?.log('complete', 'ORCID extraction complete', {
          status: result.status, source: result.source,
          authorCount: m.authorCount || 0, orcidCount: m.orcidCount || 0
        });

        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('orcid_extraction', result),
          counts: { authors: m.authorCount || 0, orcids: m.orcidCount || 0 },
          data: { doi: m.doi || null }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'orcid_extraction', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `ORCID extraction failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'orcid_extraction', round);
        }
        throw error;
      }
    },
    { concurrency: 2 }
  );

  // Markdown Convert Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.MARKDOWN_CONVERT,
    async (data, pgBossJob) => {
      const { processMarkdownConvert } = require('../pdf/markdown-convert.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.MARKDOWN_CONVERT, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting markdown conversion', { isFinalAttempt });

        const result = await processMarkdownConvert(submissionId, jobLogger, { isFinalAttempt });
        const m = result.data?.meta || {};
        jobLogger?.log('complete', isProductive(result) ? 'Markdown conversion complete' : 'Conversion failed', {
          status: result.status, source: result.source,
          markdownLength: m.markdownLength || 0, provider: m.provider || null
        });

        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('markdown_convert', result),
          data: { fileId: m.fileId || null, provider: m.provider || null, markdownLength: m.markdownLength || 0 },
          timing: { totalMs: m.totalMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'markdown_convert', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `Markdown conversion failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'markdown_convert', round);
        }
        throw error;
      }
    },
    { concurrency: 2 }
  );

  // Datasets Detection Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.DATASETS_DETECTION,
    async (data, pgBossJob) => {
      const { processDatasetDetection } = require('../datasets/datasets.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.DATASETS_DETECTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting datasets detection', { isFinalAttempt });

        const result = await processDatasetDetection(submissionId, jobLogger, { isFinalAttempt });
        const m = result.data?.meta || {};
        jobLogger?.log('detection_complete', 'Datasets detection complete', {
          status: result.status, source: result.source,
          totalCount: m.totalCount || 0, highRelevanceCount: m.highRelevanceCount || 0
        });

        // Suggestions are produced by pdf_analysis (the consolidator) at the
        // end of the pipeline; this worker just persists detection items.
        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('datasets_detection', result),
          counts: {
            total: m.totalCount || 0, unique: m.uniqueCount || 0,
            highRelevance: m.highRelevanceCount || 0
          },
          timing: {
            totalMs: m.totalMs || 0, apiMs: m.consolidationMs || 0,
            enrichMs: m.enrichMs || 0, signalMs: m.signalMs || 0
          }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'datasets_detection', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `Datasets detection failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'datasets_detection', round);
        }
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // Materials Detection Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.MATERIALS_DETECTION,
    async (data, pgBossJob) => {
      const { processMaterialsDetection } = require('../materials/materials.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.MATERIALS_DETECTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting materials detection', { isFinalAttempt });

        const result = await processMaterialsDetection(submissionId, jobLogger, { isFinalAttempt });
        const m = result.data?.meta || {};
        jobLogger?.log('detection_complete', 'Materials detection complete', {
          status: result.status, source: result.source,
          totalCount: m.totalCount || 0, highRelevanceCount: m.highRelevanceCount || 0
        });

        await jobLogger?.saveRawResponse('detection-results', result.data?.items || []);

        // Suggestions are produced by pdf_analysis (the consolidator).
        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('materials_detection', result),
          counts: {
            total: m.totalCount || 0, unique: m.uniqueCount || 0,
            highRelevance: m.highRelevanceCount || 0
          },
          timing: { totalMs: m.totalMs || 0, apiMs: m.geminiMs || 0, enrichMs: m.enrichMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'materials_detection', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `Materials detection failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'materials_detection', round);
        }
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // Protocols Detection Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.PROTOCOLS_DETECTION,
    async (data, pgBossJob) => {
      const { processProtocolsDetection } = require('../protocols/protocols.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.PROTOCOLS_DETECTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting protocols detection', { isFinalAttempt });

        const result = await processProtocolsDetection(submissionId, jobLogger, { isFinalAttempt });
        const m = result.data?.meta || {};
        jobLogger?.log('detection_complete', 'Protocols detection complete', {
          status: result.status, source: result.source,
          totalCount: m.totalCount || 0, highRelevanceCount: m.highRelevanceCount || 0
        });

        await jobLogger?.saveRawResponse('detection-results', result.data?.items || []);

        // Suggestions are produced by pdf_analysis (the consolidator).
        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('protocols_detection', result),
          counts: {
            total: m.totalCount || 0, unique: m.uniqueCount || 0,
            highRelevance: m.highRelevanceCount || 0
          },
          timing: { totalMs: m.totalMs || 0, apiMs: m.geminiMs || 0, enrichMs: m.enrichMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'protocols_detection', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `Protocols detection failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'protocols_detection', round);
        }
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // Identifier Detection Worker
  await jobQueue.registerHandler(
    jobQueue.QUEUES.IDENTIFIER_DETECTION,
    async (data, pgBossJob) => {
      const { processIdentifierDetection } = require('../identifier-detection/identifier-detection.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.IDENTIFIER_DETECTION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting identifier detection', { isFinalAttempt });

        const result = await processIdentifierDetection(submissionId, jobLogger, { isFinalAttempt });
        const m = result.data?.meta || {};
        jobLogger?.log('detection_complete', 'Identifier detection complete', {
          status: result.status, source: result.source,
          totalCount: m.totalCount || 0,
          highRelevanceCount: m.highRelevanceCount || 0,
          byRelevance: m.byRelevance || {},
          byCategory: m.byCategory || {}
        });

        await jobLogger?.saveRawResponse('detection-results', result.data?.items || []);

        // Suggestions are produced by pdf_analysis (the consolidator).
        await submissionJob?.markComplete({
          status: { detected: isProductive(result) },
          service: buildServiceSnapshot('identifier_detection', result),
          counts: {
            total: m.totalCount || 0, unique: m.uniqueCount || 0,
            highRelevance: m.highRelevanceCount || 0
          },
          timing: {
            totalMs: m.totalMs || 0,
            indexMs: m.indexMs || 0,
            scanMs: m.scanMs || 0
          }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'identifier_detection', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `Identifier detection failed: ${error.message}`);
        if (submissionJob) await submissionJob.markFailed(error.message);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'identifier_detection', round);
        }
        throw error;
      }
    },
    { concurrency: 2 }
  );

  // Auth: cron-style cleanup of stale refresh tokens
  await registerRefreshTokenCleanup(jobQueue);

  logger.info('All job workers initialized');
}

module.exports = {
  initializeWorkers,
  // Exported for testing and for the live /api/config/services endpoint
  SERVICE_CFG,
  buildServiceSnapshot,
  isFinalAttemptFor
};
