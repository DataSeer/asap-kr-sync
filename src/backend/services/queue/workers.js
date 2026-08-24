/**
 * Job Queue Workers
 *
 * Registers handlers for every pipeline step queue. Each handler:
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
const { registerPipelineReconciler } = require('./pipeline-reconciler');
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
const krtComparisonConfig = require('../../config/krt-comparison-api');
const dasSuggestionsConfig = require('../../config/das-suggestions-api');

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
  },
  // Grounding's deterministic matcher always runs and has no demo path, so the
  // module is permanently 'on'; the LM second look only enriches it. Without
  // this entry the snapshot would read 'off' after the very first run.
  krt_grounding: {
    isExternalEnabled: () => true,
    isDemoEnabled: () => false
  },
  // LM comparison (author KRT vs Generated KRT) → suggestions. LM-only, so no
  // demo path: when the comparison API isn't configured the module reads 'off'.
  suggestion_generation: {
    isExternalEnabled: () => krtComparisonConfig.isConfigured(),
    isDemoEnabled: () => false
  },
  // LM check of the DAS against the ASAP rulebook. LM-only; when not configured
  // the module reads 'off' and the frontend falls back to legacy rules.
  das_suggestions: {
    isExternalEnabled: () => dasSuggestionsConfig.isConfigured(),
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
 * Record a worker error on the SubmissionJob row.
 *
 * The distinction that matters is whether pg-boss is going to try again.
 * `failed` is terminal to every reader of these rows — including the
 * orchestrator, which treats a `failed` dependency as done — so using it for an
 * error that is about to be retried let a reconciler sweep in the backoff window
 * park the dependents in `pending_input`, permanently. See
 * `SubmissionJob.markRetrying`.
 *
 * @param {object|null} submissionJob
 * @param {Error} error
 * @param {boolean} isFinalAttempt
 */
async function recordFailure(submissionJob, error, isFinalAttempt) {
  if (!submissionJob) return;
  if (isFinalAttempt) await submissionJob.markFailed(error.message);
  else await submissionJob.markRetrying(error.message);
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

const ADVANCE_MAX_ATTEMPTS = 3;
const ADVANCE_RETRY_DELAY_MS = 500;

/**
 * After a job finishes (success or failure), advance the pipeline.
 *
 * checkAndAdvance failing here would leave dependent jobs stuck in `waiting`,
 * so we retry a few times for transient errors. If it still fails we log loudly
 * (alertable) and rely on the periodic pipeline reconciler (pipeline-reconciler.js)
 * to re-drive the stuck submission — we deliberately do NOT re-throw, because the
 * job that just finished is already complete and re-running its handler would
 * repeat its side effects.
 */
async function advancePipeline(submissionId, jobType, round, userId) {
  for (let attempt = 1; attempt <= ADVANCE_MAX_ATTEMPTS; attempt++) {
    try {
      await orchestrator.checkAndAdvance(submissionId, jobType, round, userId);
      return;
    } catch (err) {
      const willRetry = attempt < ADVANCE_MAX_ATTEMPTS;
      logger.error('Failed to advance pipeline', {
        submissionId, jobType, round, attempt, willRetry, error: err.message
      });
      if (!willRetry) {
        logger.error(
          'Pipeline advancement permanently failed after retries — dependent jobs ' +
          'may be stuck in "waiting" until the pipeline reconciler re-drives them',
          { submissionId, jobType, round }
        );
        return;
      }
      await new Promise(resolve => setTimeout(resolve, ADVANCE_RETRY_DELAY_MS * attempt));
    }
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
      // `userId` is in the payload but deliberately not read here — see
      // buildJobData. Destructuring it made it look consumed, which is what
      // made every advance that omits it look like a bug.
      const { submissionId, submissionJobId } = data;
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
        await advancePipeline(submissionId, 'pdf_analysis', round);
        return { success: true, submissionJobId };
      } catch (error) {
        jobLogger?.log('error', `PDF analysis failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
        await jobLogger?.flush();
        // Only propagate to the pipeline once pg-boss has truly given up. On
        // non-final attempts the retry will overwrite this failure, so
        // signalling dependents now would unblock them prematurely (see
        // DAS_EXTRACTION / pdf_analysis pending_input bug).
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'pdf_analysis', round);
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
          // Everything the run recorded about itself EXCEPT the statement,
          // which is the `das` field — storing it twice helps nobody.
          data: {
            das: result.data?.meta?.das || null,
            meta: (({ das, ...rest }) => rest)(result.data?.meta || {})
          }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'das_extraction', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `DAS extraction failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
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
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.REPORT_GENERATION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting report generation', { type });
        const report = await generateReport(submissionId, type, userId);
        jobLogger?.log('complete', 'Report generated', { reportId: report.id });

        if (submissionJob) await submissionJob.markComplete({ status: { detected: true }, data: { reportId: report.id } });
        await jobLogger?.flush();
        return { success: true, reportId: report.id };
      } catch (error) {
        jobLogger?.log('error', `Report generation failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
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
        await recordFailure(submissionJob, error, isFinalAttempt);
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
          // The author list lives on `submissions.authors`, which the NEXT run
          // overwrites — so a past ORCID run had a count and no list, and the
          // page could only show whoever the latest run found. Kept on the run
          // too, which is the only copy that stays true to it.
          data: { doi: m.doi || null, items: result.data?.items || [], meta: result.data?.meta || null }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'orcid_extraction', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `ORCID extraction failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
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
        await recordFailure(submissionJob, error, isFinalAttempt);
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
        await recordFailure(submissionJob, error, isFinalAttempt);
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
        await recordFailure(submissionJob, error, isFinalAttempt);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'materials_detection', round);
        }
        throw error;
      }
    },
    // 2, matching the other Gemini-backed detectors. This module used to return
    // instantly for any submission whose author listed no materials, so a
    // single worker was plenty; now it always makes a real LM call (20-120s on
    // a large manuscript) and one worker made the queue drain serially.
    { concurrency: 2 }
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
        await recordFailure(submissionJob, error, isFinalAttempt);
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
        await recordFailure(submissionJob, error, isFinalAttempt);
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

  // KRT Grounding: reconcile the author's KRT against the candidate pool.
  await jobQueue.registerHandler(
    jobQueue.QUEUES.KRT_GROUNDING,
    async (data, pgBossJob) => {
      const { processKrtGrounding } = require('../krt-grounding/krt-grounding.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.KRT_GROUNDING, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting KRT grounding', { isFinalAttempt });

        const result = await processKrtGrounding(submissionId, jobLogger);
        const m = result.data?.meta || {};
        jobLogger?.log('grounding_complete', 'KRT grounding complete', {
          mode: m.mode,
          authorRows: m.authorRows || 0,
          confirmed: m.confirmed || 0,
          incomplete: m.incomplete || 0,
          notDetected: m.notDetected || 0,
          unmatchedCandidates: m.unmatchedCandidates || 0,
          conflicts: m.conflicts || 0
        });

        await submissionJob?.markComplete({
          // "Detected" here means the step produced a reconciliation, which it
          // always does — including in no-KRT mode, where zero author rows is
          // the correct answer rather than a failure.
          status: { detected: true, mode: m.mode },
          // Both, when the LM second look ran — and it usually does. The blanket
          // 'internal' here was read as "this module calls nothing", which is
          // half the story: the presence check is deterministic and local, and
          // the rows it cannot place are then sent to Gemini. Saying only
          // "internal" beside every other module's "external" made a mixed
          // module look like a misconfigured one.
          service: buildServiceSnapshot('krt_grounding', {
            status: 'done',
            // Short on purpose: `step_executions.outcome_source` is STRING(16),
            // and a longer value does not fail loudly. The insert throws inside
            // the run-history close, which is caught and logged as "the run
            // itself is unaffected" -- true of the pipeline, but the history row
            // is then left open at `processing` for ever.
            source: m.secondLook && m.secondLook.skipped === false ? 'both' : 'internal'
          }),
          counts: {
            authorRows: m.authorRows || 0,
            confirmed: m.confirmed || 0,
            incomplete: m.incomplete || 0,
            notDetected: m.notDetected || 0,
            unmatchedCandidates: m.unmatchedCandidates || 0,
            conflicts: m.conflicts || 0,
            // From the direct search of the manuscript, not from candidate
            // matching — the same measure the editor's badge uses, so the card
            // and the modal cannot disagree about how many rows were found.
            present: m.presence?.present || 0,
            absent: m.presence?.absent || 0
          },
          timing: { totalMs: m.totalMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'krt_grounding', round);
        return { success: true, submissionId, status: result.status };
      } catch (error) {
        jobLogger?.log('error', `KRT grounding failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
        await jobLogger?.flush();
        // See DAS_EXTRACTION worker — only advance on the final attempt so
        // dependents don't observe a transient failure as terminal.
        if (isFinalAttempt) {
          await advancePipeline(submissionId, 'krt_grounding', round);
        }
        throw error;
      }
    },
    { concurrency: 2 }
  );

  // Suggestion generation: LM comparison of author KRT vs Generated KRT.
  await jobQueue.registerHandler(
    jobQueue.QUEUES.SUGGESTION_GENERATION,
    async (data, pgBossJob) => {
      const { processSuggestionGeneration } = require('../suggestion/kr-comparison.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.SUGGESTION_GENERATION, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting suggestion generation', { isFinalAttempt });
        const result = await processSuggestionGeneration(submissionId, jobLogger, { isFinalAttempt });
        const count = result.data?.suggestions?.length || 0;
        jobLogger?.log('complete', `Generated ${count} suggestions`, { count });
        await submissionJob?.markComplete({
          status: { detected: count > 0 },
          service: buildServiceSnapshot('suggestion_generation', result),
          counts: { total: count, unique: count },
          timing: { totalMs: result.meta?.totalMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'suggestion_generation', round);
        return { success: true, submissionId, count };
      } catch (error) {
        jobLogger?.log('error', `Suggestion generation failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
        await jobLogger?.flush();
        if (isFinalAttempt) await advancePipeline(submissionId, 'suggestion_generation', round);
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // DAS suggestions: LM check of the Data/Code Availability Statement.
  await jobQueue.registerHandler(
    jobQueue.QUEUES.DAS_SUGGESTIONS,
    async (data, pgBossJob) => {
      const { processDasSuggestions } = require('../das-suggestions/das-suggestions.service');
      const { submissionId, submissionJobId } = data;
      const submissionJob = await getSubmissionJob(submissionJobId, pgBossJob);
      const { manuscriptId, round } = await loadSubmission(submissionId);
      const jobLogger = submissionJob ? createJobLogger(submissionJob, manuscriptId, round) : null;
      const isFinalAttempt = isFinalAttemptFor(jobQueue.QUEUES.DAS_SUGGESTIONS, pgBossJob);

      try {
        jobLogger?.log('start', 'Starting DAS suggestions', { isFinalAttempt });
        const result = await processDasSuggestions(submissionId, jobLogger, { isFinalAttempt });
        const applicable = result.data?.suggestions?.filter(s => s.applies).length || 0;
        jobLogger?.log('complete', `DAS check complete: ${applicable} applicable`, { applicable });
        await submissionJob?.markComplete({
          status: { detected: applicable > 0 },
          service: buildServiceSnapshot('das_suggestions', result),
          counts: { total: result.data?.suggestions?.length || 0, unique: applicable },
          timing: { totalMs: result.meta?.totalMs || 0 }
        });
        await jobLogger?.flush();
        await advancePipeline(submissionId, 'das_suggestions', round);
        return { success: true, submissionId, applicable };
      } catch (error) {
        jobLogger?.log('error', `DAS suggestions failed: ${error.message}`);
        await recordFailure(submissionJob, error, isFinalAttempt);
        await jobLogger?.flush();
        if (isFinalAttempt) await advancePipeline(submissionId, 'das_suggestions', round);
        throw error;
      }
    },
    { concurrency: 1 }
  );

  // Auth: cron-style cleanup of stale refresh tokens
  await registerRefreshTokenCleanup(jobQueue);

  // Safety net: periodically re-drive pipelines whose advancement was dropped
  await registerPipelineReconciler(jobQueue);

  logger.info('All job workers initialized');
}

module.exports = {
  initializeWorkers,
  // Exported for testing and for the live /api/config/services endpoint
  SERVICE_CFG,
  buildServiceSnapshot,
  isFinalAttemptFor
};
