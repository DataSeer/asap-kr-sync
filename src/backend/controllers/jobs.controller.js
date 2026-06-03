/**
 * Jobs Controller
 * Returns background job statuses for a submission.
 *
 * All endpoints support an optional `?round=N` query parameter.
 * When omitted, defaults to the submission's current round.
 */

const { SubmissionJob } = require('../models');
const { JOB_CONFIG, QUEUES } = require('../services/queue/job-queue.service');
const orchestrator = require('../services/queue/orchestrator.service');
const s3Service = require('../services/storage/s3.service');
const { ROLES } = require('../config/constants');

const JOB_TYPE_TO_QUEUE = {
  pdf_analysis: QUEUES.PDF_ANALYSIS,
  das_extraction: QUEUES.DAS_EXTRACTION,
  markdown_convert: QUEUES.MARKDOWN_CONVERT,
  software_detection: QUEUES.SOFTWARE_DETECTION,
  orcid_extraction: QUEUES.ORCID_EXTRACTION,
  datasets_detection: QUEUES.DATASETS_DETECTION,
  materials_detection: QUEUES.MATERIALS_DETECTION,
  protocols_detection: QUEUES.PROTOCOLS_DETECTION,
  report_generation: QUEUES.REPORT_GENERATION
};

/**
 * Resolve the round number from ?round=N query param, or fall back to submission.currentRound.
 * @param {object} req
 * @returns {number}
 */
function resolveRound(req) {
  const queryRound = parseInt(req.query.round, 10);
  return queryRound > 0 ? queryRound : req.submission.currentRound;
}

/**
 * Get jobs for a submission
 * GET /api/submissions/:id/jobs?round=N
 *
 * Authors receive a redacted payload (no logs, no raw response file map, no
 * queue config). Other roles (PM, ds_annotator, admin) get the full technical
 * details so they can debug pipeline behavior.
 */
async function getJobs(req, res, next) {
  try {
    const round = resolveRound(req);
    const jobs = await SubmissionJob.getForSubmission(req.params.id, round);
    const includeInternals = req.user?.role !== ROLES.AUTHOR;

    res.json({
      round,
      jobs: jobs.map(job => {
        const queueName = JOB_TYPE_TO_QUEUE[job.jobType];
        const config = queueName ? JOB_CONFIG[queueName] : null;

        // Compute elapsed time for running jobs
        let elapsedMs = null;
        if (job.startedAt && (job.status === 'processing' || job.status === 'queued')) {
          elapsedMs = Date.now() - new Date(job.startedAt).getTime();
        } else if (job.startedAt && job.completedAt) {
          elapsedMs = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
        }

        // Strip raw `files` map (S3 keys to raw responses) from job.result for authors
        let safeResult = job.result;
        if (!includeInternals && job.result && typeof job.result === 'object') {
          const { files, ...rest } = job.result;
          safeResult = rest;
        }

        return {
          id: job.id,
          jobType: job.jobType,
          status: job.status,
          referenceId: job.referenceId,
          result: safeResult,
          errorMessage: job.errorMessage,
          retryCount: job.retryCount || 0,
          round: job.round,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          createdAt: job.createdAt,
          logs: includeInternals ? (job.logs || []) : [],
          files: includeInternals ? (job.result?.files || {}) : {},
          elapsedMs,
          config: includeInternals && config ? {
            expireInSeconds: config.expireInSeconds,
            retryLimit: config.retryLimit,
            retryDelay: config.retryDelay || 60,
            maxTotalSeconds: (config.expireInSeconds * (config.retryLimit + 1))
              + ((config.retryDelay || 60) * config.retryLimit)
          } : null,
          // Public budget hints used by the global wait-time indicator. Even
          // authors get these so the ETA bar works for every role; they're
          // just the per-attempt expiry budget (max) and the median
          // completion time (typical) — not the full internal queue config.
          expireInSeconds: config ? config.expireInSeconds : null,
          typicalSeconds: config ? config.typicalSeconds : null
        };
      })
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Run all background processes for a submission
 * POST /api/submissions/:id/processes/run
 */
async function runProcesses(req, res, next) {
  try {
    const submission = req.submission;
    const jobs = await orchestrator.runAllProcesses(
      submission.id,
      req.userId,
      submission.currentRound
    );

    res.json({
      message: 'All processes started',
      jobs: jobs.map(j => ({ jobType: j.jobType, status: j.status }))
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Manually advance a pending_input job to queued
 * POST /api/submissions/:id/jobs/:jobType/advance?round=N
 */
async function advanceJob(req, res, next) {
  try {
    const submission = req.submission;
    const { jobType } = req.params;
    const round = resolveRound(req);

    const job = await orchestrator.advanceJob(
      submission.id,
      jobType,
      round,
      req.userId
    );

    res.json({
      message: `Job ${jobType} advanced to queued`,
      job: { id: job.id, jobType: job.jobType, status: job.status, round: job.round }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get a presigned download URL for a job's raw response file
 * GET /api/submissions/:id/jobs/:jobType/responses/:responseName?round=N
 */
async function getJobResponse(req, res, next) {
  try {
    const submission = req.submission;
    const { jobType, responseName } = req.params;
    const round = resolveRound(req);

    const job = await SubmissionJob.getLatest(submission.id, jobType, round);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const s3Key = job.result?.files?.[responseName];
    if (!s3Key) {
      return res.status(404).json({ error: 'Response not found' });
    }

    const url = await s3Service.getPresignedDownloadUrl(s3Key);
    res.json({ url, name: responseName, s3Key, round: job.round });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getJobs,
  runProcesses,
  advanceJob,
  getJobResponse
};
