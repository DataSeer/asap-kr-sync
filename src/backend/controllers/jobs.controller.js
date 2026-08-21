/**
 * Jobs Controller
 * Returns background job statuses for a submission.
 *
 * All endpoints support an optional `?round=N` query parameter.
 * When omitted, defaults to the submission's current round.
 */

const { SubmissionJob, SubmissionJobRun, User } = require('../models');
const { JOB_TYPES } = require('../config/constants');
const { ValidationError, NotFoundError } = require('../utils/errors');
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
/**
 * Gate name → the reason the UI shows. Named separately because the gate is an
 * implementation detail of the pipeline table and the reason is a contract with
 * the frontend: renaming a gate must not silently change what users read.
 */
const WAITING_REASONS = {
  krt_curated: 'krt_validation',
  markdown_ready: 'markdown_missing',
  // Not a stall: this step belongs to a later stage of the submission. The
  // client uses this to keep it out of "all processes finished" — a step the
  // user has not reached is not outstanding work for the step they are on.
  availability_ready: 'availability_step'
};

async function getJobs(req, res, next) {
  try {
    const round = resolveRound(req);
    const jobs = await SubmissionJob.getForSubmission(req.params.id, round);
    const includeInternals = req.user?.role !== ROLES.AUTHOR;

    // Who asked for each step. One extra query rather than an include on
    // getForSubmission: that method is also the orchestrator's hot path on
    // every advance, and it has no use for a join it would pay for each time.
    // An anonymised account still resolves — the row survives deletion with
    // the name 'Deleted user' — so a name is either real or an honest
    // tombstone, never a dangling id.
    const triggerIds = [...new Set(jobs.map((j) => j.triggeredByUserId).filter(Boolean))];
    const triggers = triggerIds.length
      ? await User.findAll({ where: { id: triggerIds }, attributes: ['id', 'name'], raw: true })
      : [];
    const triggerById = new Map(triggers.map((u) => [u.id, u.name]));
    // Gates can read a dependency's result — "is there any converted text?" —
    // so they need the run, not just the submission.
    const jobsByType = new Map(jobs.map(j => [j.jobType, j]));

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
          waitingReason: job.status === 'waiting'
            ? WAITING_REASONS[orchestrator.isGateBlocked(job.jobType, req.submission, jobsByType)] || null
            : null,
          referenceId: job.referenceId,
          result: safeResult,
          errorMessage: job.errorMessage,
          // null for a step no user asked for by hand, or a row older than the
          // column. The UI says "automatically" rather than inventing a name.
          triggeredBy: job.triggeredByUserId
            ? { id: job.triggeredByUserId, name: triggerById.get(job.triggeredByUserId) || null }
            : null,
          // How many times this step has run in this round, and therefore which
          // run the numbers beside it belong to. Denormalised onto the job row,
          // so the panel costs no extra query — this endpoint is polled every
          // few seconds by every open tab.
          runCount: job.runCount ?? 1,
          runNumber: job.runCount ?? 1,
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

    // hasOwnProperty, not a bare lookup: `files` is a plain object, so
    // `.../responses/constructor` returned an inherited function, sailed past a
    // truthiness check, and blew up in the S3 client with a TypeError — a 500
    // where a 404 belongs.
    const files = job.result?.files;
    const s3Key = files && Object.prototype.hasOwnProperty.call(files, responseName)
      ? files[responseName]
      : null;
    if (typeof s3Key !== 'string' || !s3Key) {
      return res.status(404).json({ error: 'Response not found' });
    }

    const url = await s3Service.getPresignedDownloadUrl(s3Key);

    // `?redirect=1` sends the caller to the file itself. Without it the caller
    // gets JSON and has to open the url in a second step, which cannot be a
    // plain link — so ctrl-click, middle-click and "open in new tab" all stop
    // working on something that is, to a reader, just a file.
    if (req.query.redirect !== undefined && req.query.redirect !== 'false') {
      return res.redirect(302, url);
    }
    res.json({ url, name: responseName, s3Key, round: job.round });
  } catch (error) {
    next(error);
  }
}

/**
 * The prompt(s) this run actually used, read back from its frozen inputs.
 * GET /api/submissions/:id/jobs/:jobType/prompts?round=N
 *
 * Served from the run's own stored copy, never from the file on disk and never
 * as a link to GitHub. A deployment is not always at the head of its branch,
 * and prompt files get edited, renamed and deleted — so a link showed a reader
 * a prompt that may not be the one that ran, silently and with no way to tell.
 * The run froze its copy; this hands that copy back.
 *
 * Not folded into GET /jobs: that payload is polled every few seconds, and a
 * prompt template per module would add tens of kilobytes to every poll for
 * something read only when a panel is opened.
 */
async function getJobPrompts(req, res, next) {
  try {
    const submission = req.submission;
    const { jobType } = req.params;
    const round = resolveRound(req);

    const job = await SubmissionJob.getLatest(submission.id, jobType, round);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const s3Key = job.result?.files?.inputs;
    if (typeof s3Key !== 'string' || !s3Key) {
      // A run that stored no inputs artefact. Not an error — a skipped or
      // fallback run has none — so the caller gets an empty list and can say
      // "this run recorded no prompt" rather than showing a spinner for ever.
      return res.json({ prompts: [], round: job.round, reason: 'no_inputs_artefact' });
    }

    let inputs;
    try {
      inputs = JSON.parse((await s3Service.downloadFile(s3Key)).toString('utf-8'));
    } catch (error) {
      logger.warn('Could not read a run\'s frozen inputs', { jobType, s3Key, error: error.message });
      return res.json({ prompts: [], round: job.round, reason: 'inputs_unreadable' });
    }

    // Every prompt a run recorded, whatever the module called it. Datasets
    // records two (detection and signal extraction), so this reads the shape
    // rather than a fixed list of names.
    const prompts = Object.entries(inputs)
      .filter(([, v]) => v && typeof v === 'object' && typeof v.promptFile === 'string')
      .map(([key, v]) => ({
        key,
        file: v.promptFile,
        text: v.templateText ?? null,
        sha256: v.templateSha256 ?? null,
        bytes: v.templateBytes ?? null,
        // Files the prompt cannot work without — LangExtract's few-shot
        // examples JSON. It is passed to the extractor as a separate argument
        // and never enters the prompt text, so showing the template alone
        // would show only part of what the run was given.
        attachments: Array.isArray(v.attachments) ? v.attachments : []
      }));

    res.json({ prompts, round: job.round });
  } catch (error) {
    next(error);
  }
}

/**
 * Shape a run record the way the module page already reads a job.
 *
 * The page renders from `job.result.data.*`, `job.triggeredBy`, `job.status`
 * and the timestamps. Returning a run in that shape means a past run renders
 * through exactly the same path as the current one — no second rendering
 * branch, and no chance of the two drifting.
 *
 * @param {object} run - a SubmissionJobRun
 * @param {object} extras - `runCount`, `triggeredBy`, `isLatest`
 */
function shapeRun(run, { runCount, triggeredBy, isLatest }) {
  return {
    jobType: run.jobType,
    round: run.round,
    runNumber: run.runNumber,
    runCount,
    isLatest,
    status: run.status,
    result: run.result,
    logs: run.logs || [],
    files: run.result?.files || {},
    inputs: run.inputs || null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs: run.durationMs,
    retryCount: run.retryCount || 0,
    triggeredBy,
    triggerKind: run.triggerKind,
    s3Prefix: run.s3Prefix
  };
}

/** The person who asked for a run, or null. */
async function resolveTrigger(userId) {
  if (!userId) return null;
  const user = await User.findByPk(userId, { attributes: ['id', 'name'] });
  return { id: userId, name: user ? user.name : null };
}

/**
 * Reject a job type the pipeline does not have, before it reaches a query.
 * A typo in a URL is the caller's mistake, not a server error.
 */
function assertKnownJobType(jobType) {
  if (!Object.values(JOB_TYPES).includes(jobType)) {
    throw new ValidationError(
      `Unknown step: "${jobType}". Expected one of: ${Object.values(JOB_TYPES).join(', ')}`
    );
  }
}

/**
 * Every run of one step, newest first.
 * GET /api/submissions/:id/jobs/:jobType/runs
 */
async function listRuns(req, res, next) {
  try {
    const { jobType } = req.params;
    assertKnownJobType(jobType);
    const round = resolveRound(req);

    // Metadata only: the payloads are megabytes and a list shows none of them.
    const runs = await SubmissionJobRun.listForStep(req.params.id, jobType, round, { metadataOnly: true });

    const names = new Map();
    for (const id of new Set(runs.map((r) => r.triggeredByUserId).filter(Boolean))) {
      names.set(id, await resolveTrigger(id));
    }

    res.json({
      round,
      jobType,
      runCount: runs.length,
      runs: runs.map((run, index) => ({
        runNumber: run.runNumber,
        // The list is newest-first, so the first entry is the current run.
        isLatest: index === 0,
        status: run.status,
        outcomeState: run.outcomeState,
        outcomeSource: run.outcomeSource,
        failReason: run.failReason,
        externalError: run.externalError,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        retryCount: run.retryCount,
        counts: run.counts,
        triggerKind: run.triggerKind,
        triggeredBy: names.get(run.triggeredByUserId) || null
      }))
    });
  } catch (error) {
    next(error);
  }
}

/**
 * One run, in full.
 * GET /api/submissions/:id/jobs/:jobType/runs/:runNumber
 */
async function getRun(req, res, next) {
  try {
    const { jobType } = req.params;
    assertKnownJobType(jobType);

    const runNumber = Number.parseInt(req.params.runNumber, 10);
    if (!Number.isInteger(runNumber) || runNumber < 1) {
      throw new ValidationError(`Not a run number: "${req.params.runNumber}"`);
    }
    const round = resolveRound(req);

    const runs = await SubmissionJobRun.listForStep(req.params.id, jobType, round, { metadataOnly: true });
    if (runs.length === 0) throw new NotFoundError(`Runs for ${jobType}`);

    const run = await SubmissionJobRun.findOne({
      where: { submissionId: req.params.id, jobType, round, runNumber }
    });
    if (!run) throw new NotFoundError(`Run ${runNumber} of ${jobType}`);

    res.json({
      run: shapeRun(run, {
        runCount: runs.length,
        triggeredBy: await resolveTrigger(run.triggeredByUserId),
        // Newest-first, so the highest number is the current run.
        isLatest: run.runNumber === runs[0].runNumber
      })
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getJobs,
  runProcesses,
  advanceJob,
  cancelProcessing,
  getJobResponse,
  getJobPrompts,
  listRuns,
  getRun
};
