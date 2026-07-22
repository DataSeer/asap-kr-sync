/**
 * Jobs Controller
 * Returns background job statuses for a submission.
 *
 * All endpoints support an optional `?round=N` query parameter.
 * When omitted, defaults to the submission's current round.
 */

const { SubmissionJob } = require('../models');
const jobQueue = require('../services/queue/job-queue.service');
const { JOB_CONFIG, JOB_TYPE_TO_QUEUE } = jobQueue;
const orchestrator = require('../services/queue/orchestrator.service');
const s3Service = require('../services/storage/s3.service');
const { ROLES } = require('../config/constants');
const logger = require('../utils/logger');

// Statuses of jobs that have NOT started yet — these can be truly cancelled
// (they will never run). A 'processing' job is deliberately excluded: it is
// already mid-flight and is left to finish and record its real status.
const NOT_STARTED_STATUSES = ['waiting', 'pending_input', 'queued'];

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
          // Explains a `waiting` status the dependency graph can't: the step
          // is gated on submission state (e.g. KRT not yet validated).
          waitingReason: job.status === 'waiting' && orchestrator.isGateBlocked(job.jobType, req.submission)
            ? 'krt_validation'
            : null,
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
      message: `Job ${jobType} is now '${job.status}'`,
      job: { id: job.id, jobType: job.jobType, status: job.status, round: job.round }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Cancel all in-flight background processing for a submission.
 * POST /api/submissions/:id/processes/cancel?round=N
 *
 * Best-effort: cancels the underlying queue job (so a queued/running job stops)
 * and marks each active SubmissionJob as cancelled. Lets a user abort a wrong
 * document instead of waiting for the whole pipeline to finish (#15).
 */
async function cancelProcessing(req, res, next) {
  try {
    const submission = req.submission;
    const round = resolveRound(req);

    const jobs = await SubmissionJob.getForSubmission(submission.id, round);
    const notStarted = jobs.filter(job => NOT_STARTED_STATUSES.includes(job.status));
    const stillRunning = jobs.filter(job => job.status === 'processing');

    let cancelled = 0;
    for (const job of notStarted) {
      // Remove the queued pg-boss job so no worker ever picks it up. Best-effort
      // — a waiting/pending_input job has no pg-boss job yet, and a queued one
      // may already be gone. Marking the row 'cancelled' is what actually stops
      // it: the orchestrator refuses to (re-)enqueue a job in a cancelled run.
      const queueName = JOB_TYPE_TO_QUEUE[job.jobType];
      if (queueName && job.pgBossJobId) {
        try {
          await jobQueue.cancelJob(queueName, job.pgBossJobId);
        } catch (cancelErr) {
          logger.warn('Cancel: queue cancel failed (continuing to mark job)', {
            submissionId: submission.id,
            jobType: job.jobType,
            error: cancelErr.message
          });
        }
      }
      await job.markCancelled();
      cancelled += 1;
    }

    // A module already running can't be interrupted — it finishes and records
    // its real done/failed status. Marking siblings 'cancelled' above is enough
    // to stop the pipeline from advancing past it and to skip its retries.
    logger.info('Processing cancelled by user', {
      submissionId: submission.id,
      round,
      cancelled,
      stillRunning: stillRunning.length,
      userId: req.userId
    });

    res.json({
      message: `Cancelled ${cancelled} process${cancelled === 1 ? '' : 'es'}`,
      cancelled,
      stillRunning: stillRunning.length,
      round
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
  cancelProcessing,
  getJobResponse
};
