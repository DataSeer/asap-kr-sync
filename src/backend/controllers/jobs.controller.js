/**
 * Jobs Controller
 * Returns background job statuses for a submission.
 *
 * All endpoints support an optional `?round=N` query parameter.
 * When omitted, defaults to the submission's current round.
 */

const { SubmissionJob, User } = require('../models');
const { JOB_TYPES } = require('../config/constants');
const { ValidationError, NotFoundError } = require('../utils/errors');

/**
 * The pipeline is twelve steps. A longer selection is a caller bug, and
 * answering it would be twelve restarts' worth of work for one request.
 */
const PIPELINE_STEP_LIMIT = 20;
const jobQueue = require('../services/queue/job-queue.service');
const { JOB_CONFIG, JOB_TYPE_TO_QUEUE } = jobQueue;
const orchestrator = require('../services/queue/orchestrator.service');
const s3Service = require('../services/storage/s3.service');
const { ROLES } = require('../config/constants');
const logger = require('../utils/logger');
const inputFreeze = require('../services/queue/input-freeze.service');
const pipelineRuns = require('../services/queue/pipeline-run.service');

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
  blocked_by_failure: 'blocked_by_failure',
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
    // Both the people who STARTED a step and the people who DECIDED about one:
    // an issue's "carried on by Nicolas" needs the same name lookup, and
    // whoever acknowledged a failure need never have triggered anything.
    const triggerIds = [...new Set(
      jobs.flatMap((j) => [j.triggeredByUserId, j.decision?.byUserId, j.cancelledByUserId]).filter(Boolean)
    )];
    const triggers = triggerIds.length
      ? await User.findAll({ where: { id: triggerIds }, attributes: ['id', 'name'], raw: true })
      : [];
    const triggerById = new Map(triggers.map((u) => [u.id, u.name]));
    // Gates can read a dependency's result — "is there any converted text?" —
    // so they need the run, not just the submission.
    const jobsByType = new Map(jobs.map(j => [j.jobType, j]));

    // What this round is being processed from, and whether the live data has
    // moved on since. Without it the page shows a result beside inputs that may
    // no longer be the ones it was built from, and says nothing about the
    // difference — which is how an author comes to trust an analysis of a
    // manuscript they have already replaced.
    //
    // Non-fatal: a pipeline page that fails to load because a provenance note
    // could not be computed is a worse page.
    let inputs = [];
    try {
      inputs = await inputFreeze.describe(req.params.id, round);
    } catch (err) {
      logger.error('Could not describe the round\'s frozen inputs', {
        submissionId: req.params.id, round, error: err.message
      });
    }

    // Which run this round is in. One query for the whole payload, because a
    // run number belongs to the ROUND now, not to each step — that is the point
    // of the model, and it is also what stopped the module page's header saying
    // "run 2" while its own metadata panel said "run 1" two inches below.
    //
    // Non-fatal for the same reason as the freezes above: a pipeline page that
    // will not load because it could not number the run is a worse page.
    let currentRun = null;
    try {
      currentRun = await pipelineRuns.currentRun(req.params.id, round);
    } catch (err) {
      logger.error('Could not read the round\'s current pipeline run', {
        submissionId: req.params.id, round, error: err.message
      });
    }

    // Everything about this round that needs a person, computed once. Five
    // surfaces render it; none of them re-derives it.
    const issues = orchestrator.describeIssues(jobsByType).map((issue) => ({
      ...issue,
      decided: issue.decided
        ? { ...issue.decided, byName: triggerById.get(issue.decided.byUserId) || null }
        : null
    }));

    res.json({
      round,
      inputs,
      issues,
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
            // A failure held in front of it comes FIRST: a step blocked behind a
            // failed dependency is also, usually, behind that dependency's gate,
            // and "waiting for the converted manuscript" is a true but useless
            // thing to say when the conversion failed and needs a decision.
            ? (orchestrator.blockingIssues(job.jobType, jobsByType).length
              ? WAITING_REASONS.blocked_by_failure
              : WAITING_REASONS[orchestrator.isGateBlocked(job.jobType, req.submission, jobsByType)] || null)
            : null,
          /** Which failed steps are holding this one — named, so the UI can point at them. */
          blockedBy: job.status === 'waiting'
            ? orchestrator.blockingIssues(job.jobType, jobsByType)
            : [],
          /**
           * When somebody decided to carry on without this step, and who. Only
           * ever set on a failed step, and the only way to tell "this was
           * skipped" from "this found nothing" after the fact.
           */
          issueAcknowledgedAt: job.decision?.at || null,
          /**
           * A cancel that could not stop the call.
           *
           * Here rather than only on the run endpoints because the module page
           * reads its status from THIS payload — without it a cancelled step
           * says "cancelled" and cannot say by whom, or that an answer arrived
           * afterwards and was billed.
           */
          cancelledBy: job.cancelledByUserId
            ? { id: job.cancelledByUserId, name: triggerById.get(job.cancelledByUserId) || null }
            : null,
          discarded: job.discarded || [],
          referenceId: job.referenceId,
          result: safeResult,
          errorMessage: job.errorMessage,
          // null for a step no user asked for by hand, or a row older than the
          // column. The UI says "automatically" rather than inventing a name.
          triggeredBy: job.triggeredByUserId
            ? { id: job.triggeredByUserId, name: triggerById.get(job.triggeredByUserId) || null }
            : null,
          // Which run the numbers beside this step belong to. The PIPELINE
          // run's number, the same for every step in the payload: "run 2" has
          // to mean one thing across the page, and per-step numbering meant it
          // could mean twelve.
          //
          // Runs are numbered 1..N per round, so the newest number is also the
          // count. Falling back to 1 rather than to the step's own count, which
          // is the number this replaces.
          runCount: currentRun?.runNumber ?? 1,
          runNumber: currentRun?.runNumber ?? 1,
          // How many times this STEP has executed in the round. Kept, and named
          // for what it is: it answers "has this been re-run", which the run
          // number no longer does now that a run can carry a step over.
          executionCount: job.runCount ?? 0,
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
 * Restart several steps as ONE restart.
 *
 * POST /api/submissions/:id/processes/restart  { jobTypes: [...] }
 *
 * Restarting them one at a time is not the same thing and costs more: the first
 * detector finishes, grounding finds every dependency terminal and starts, and
 * the next restart resets it — so grounding runs twice and both runs are paid
 * for. The orchestrator resets the whole union before enqueueing anything.
 */
async function restartProcesses(req, res, next) {
  try {
    const submission = req.submission;
    const { jobTypes } = req.body || {};
    if (!Array.isArray(jobTypes) || !jobTypes.length) {
      throw new ValidationError('jobTypes must be a non-empty array of pipeline step names');
    }
    if (jobTypes.length > PIPELINE_STEP_LIMIT) {
      // The pipeline has twelve steps; a longer list is a caller bug, and
      // answering it would be twelve restarts' worth of work per request.
      throw new ValidationError(`At most ${PIPELINE_STEP_LIMIT} steps can be restarted at once`);
    }

    // Which parameters to run with. Default `live`: the common restart is "I
    // changed the prompt, run it again", and defaulting to frozen would make
    // that button quietly do nothing.
    const paramsSource = req.body?.paramsSource === 'frozen' ? 'frozen' : 'live';

    const { restarted, reset } = await orchestrator.restartSteps(
      submission.id, jobTypes, submission.currentRound, req.userId, { paramsSource }
    );

    res.json({
      message: restarted.length === 1
        ? `${restarted[0]} re-started`
        : `${restarted.length} steps re-started`,
      restarted,
      // What the restart carried with it. The UI already told the user, but the
      // reply is what a script or a log has to go on.
      reset,
      paramsSource
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Run a failed step again, and change nothing else.
 *
 * POST /api/submissions/:id/jobs/:jobType/retry?round=N
 *
 * For the case that comes up after an external service is fixed: the pipeline is
 * stuck behind one failure, and what is wanted is to unblock it rather than
 * re-run the round. Refused once anything downstream has run since — retrying
 * alone would leave those results built on the failure, which is a restart's job.
 */
async function retryJob(req, res, next) {
  try {
    const submission = req.submission;
    const job = await orchestrator.retryStep(
      submission.id, req.params.jobType, resolveRound(req), req.userId
    );

    res.json({
      message: `${req.params.jobType} is running again`,
      jobType: job.jobType,
      status: job.status
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Carry on without a failed step's data.
 *
 * POST /api/submissions/:id/jobs/:jobType/continue?round=N
 *
 * The second answer a failure asks for; Retry is the other. Nothing is re-run
 * and the step stays `failed` — what is recorded is that a person decided the
 * pipeline should proceed without it, which is the only way anyone can later
 * tell "software detection was skipped" from "software detection found nothing".
 */
async function continueWithoutJob(req, res, next) {
  try {
    const submission = req.submission;
    const job = await orchestrator.acknowledgeIssue(
      submission.id, req.params.jobType, resolveRound(req), req.userId
    );

    res.json({
      message: `Continuing without ${req.params.jobType}`,
      jobType: job.jobType,
      acknowledgedAt: job.decision?.at
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
 * A cancel INTERRUPTS. Every step that has not finished — waiting, queued and
 * the one actually running — becomes `cancelled`, unusable, and must be re-run.
 *
 * A running step used to be left alone to finish and record its real status,
 * which meant pressing Cancel on the one thing actually burning money did
 * nothing a user could see: the module carried on, its result landed, and the
 * pipeline treated it as a normal success.
 *
 * What still cannot be interrupted is the external call. The promise is
 * abandoned, the call completes, and it is billed — so when the answer arrives
 * it is recorded on the execution as discarded, with what it cost, rather than
 * dropped. See SubmissionJob.markComplete.
 *
 * Lets a user abort a wrong document instead of waiting for the whole pipeline
 * to finish (#15).
 */
async function cancelProcessing(req, res, next) {
  try {
    const submission = req.submission;
    const round = resolveRound(req);

    const jobs = await SubmissionJob.getForSubmission(submission.id, round);
    const stillRunning = jobs.filter(job => job.status === 'processing');
    // Running steps LAST. Marking them first would let the guard in
    // markComplete fire while their siblings were still queued, and a worker
    // that finished in that window would advance the pipeline past a cancel
    // only half applied.
    const toCancel = [...jobs.filter(job => NOT_STARTED_STATUSES.includes(job.status)), ...stillRunning];

    let cancelled = 0;
    for (const job of toCancel) {
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
      await job.markCancelled(req.userId);
      cancelled += 1;
    }

    logger.info('Processing cancelled by user', {
      submissionId: submission.id,
      round,
      cancelled,
      // Named, because these are the ones with a call in flight: their answer
      // will arrive and be recorded as discarded.
      interrupted: stillRunning.map((job) => job.jobType),
      userId: req.userId
    });

    res.json({
      message: `Cancelled ${cancelled} process${cancelled === 1 ? '' : 'es'}`,
      cancelled,
      // Still the count of steps whose external call was in flight. They are
      // cancelled now — the name is kept because the client reads it — but
      // their answer is still coming, and will be recorded as discarded.
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

    // `?run=N` asks for a PAST run's prompt. Without it this always answered
    // for the latest run, so selecting run 1 on the module page showed run 3's
    // prompt beside run 1's results — the page contradicting itself.
    const wanted = req.query.run ? Number.parseInt(req.query.run, 10) : null;
    if (req.query.run && (!Number.isInteger(wanted) || wanted < 1)) {
      throw new ValidationError(`Not a run number: "${req.query.run}"`);
    }

    // Through the pipeline run, so `?run=2` means the same thing here as it does
    // in the selector that produced it. Resolving it against the step's own
    // numbering would answer for a different run whenever anything was carried
    // over — the page contradicting itself, quietly.
    const job = wanted
      ? (await pipelineRuns.stepInRun(submission.id, round, jobType, wanted))?.execution
      : await SubmissionJob.getLatest(submission.id, jobType, round);
    if (!job) {
      return res.status(404).json({ error: wanted ? `Run ${wanted} not found` : 'Job not found' });
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
 * @param {object} run - a StepExecution
 * @param {object} extras - `runCount`, `triggeredBy`, `isLatest`
 */
function shapeRun(run, {
  runCount, triggeredBy, isLatest, runNumber, carriedOver = false, producedByRun = null,
  cause = null, cancelledBy = null, paramsSource = 'live'
}) {
  return {
    jobType: run.jobType,
    round: run.round,
    // The PIPELINE run's number. The execution no longer has one of its own —
    // numbering the step inside the run was the ambiguity this model removed.
    runNumber,
    runCount,
    isLatest,
    cause,
    paramsSource,
    carriedOver,
    producedByRun,
    attempts: run.attempts || [],
    /**
     * When a person stopped this execution, and what arrived afterwards anyway.
     *
     * The pair is the point: `cancelledAt` says the answer below was not wanted,
     * and `discarded` says one came, and what it cost. Either alone reads as a
     * step that simply produced nothing.
     */
    cancelledAt: run.cancelledAt || null,
    cancelledBy: cancelledBy || null,
    discarded: run.discarded || [],
    status: run.status,
    result: run.result,
    logs: run.logs || [],
    files: run.result?.files || {},
    inputs: run.inputs || null,
    /**
     * The submission's documents as they were when this run opened, in the
     * shape SubmissionFileLinks already takes — `{ krt: { id, ... } }`.
     *
     * `fileId` becomes `id` because the download endpoint takes a file id, and
     * an older version is its own row: asking for it returns exactly the file
     * this run was contemporaneous with, not the current one.
     */
    documents: Object.fromEntries(
      Object.entries(run.inputs?.documents || {})
        .map(([name, ref]) => [name, { ...ref, id: ref.fileId }])
    ),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs: run.durationMs,
    retryCount: run.retryCount || 0,
    triggeredBy,
    triggerKind: run.triggerKind,
    s3Prefix: run.s3Prefix,
    /**
     * Whether this run's stored artefacts are *its own*.
     *
     * Artefacts are keyed by run number now, but runs recorded before that
     * shared one folder per job row — so the last run to write won, and an
     * earlier run's links resolve to a later run's data. Showing them would be
     * worse than showing nothing: they look like this run's evidence and are
     * not. A run-scoped prefix is the proof that they are.
     */
    artefactsAreOwn: typeof run.s3Prefix === 'string' && run.s3Prefix.includes('/run-')
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
 * Every PIPELINE RUN of this round that contains this step, newest first.
 * GET /api/submissions/:id/jobs/:jobType/runs
 *
 * "Every run of this step" is what this used to answer, and the numbers it gave
 * back were per step: software run 3 beside materials run 1, no way to say which
 * belonged together. A run is now one attempt at the whole round, so run 2 means
 * the same thing on every module page.
 *
 * A step that was CARRIED OVER — the run did not re-execute it — still appears,
 * flagged, naming the run that did the work. Under the old numbering it simply
 * vanished from the list, so somebody comparing run 2 with run 3 saw the step
 * disappear rather than being told it was unchanged.
 */
async function listRuns(req, res, next) {
  try {
    const { jobType } = req.params;
    assertKnownJobType(jobType);
    const round = resolveRound(req);

    // Metadata only: the payloads are megabytes and a list shows none of them.
    const entries = await pipelineRuns.runsForStep(req.params.id, round, jobType, { metadataOnly: true });

    const names = new Map();
    for (const id of new Set(entries.map((e) => e.execution?.triggeredByUserId).filter(Boolean))) {
      names.set(id, await resolveTrigger(id));
    }

    res.json({
      round,
      jobType,
      runCount: entries.length,
      runs: entries.map((entry, index) => {
        const execution = entry.execution;
        return {
          runNumber: entry.runNumber,
          // Newest first, so the first entry is the run the pipeline is in.
          isLatest: index === 0,
          cause: entry.cause,
          runStatus: entry.runStatus,
          paramsSource: entry.paramsSource,
          // The pair that keeps the list honest: an execution appears in every
          // run that carried it, and a number over somebody else's result with
          // nothing saying so is how "why does this still say 14 items" starts.
          carriedOver: entry.carriedOver,
          producedByRun: entry.producedByRun,
          // `not_started` rather than null: a run that contains a step which
          // has not run yet is a normal state while the run is going, and the
          // selector has to be able to say so.
          status: execution?.status || 'not_started',
          outcomeState: execution?.outcomeState ?? null,
          outcomeSource: execution?.outcomeSource ?? null,
          failReason: execution?.failReason ?? null,
          externalError: execution?.externalError ?? null,
          startedAt: execution?.startedAt ?? null,
          completedAt: execution?.completedAt ?? null,
          durationMs: execution?.durationMs ?? null,
          retryCount: execution?.retryCount ?? 0,
          attemptCount: Array.isArray(execution?.attempts) ? execution.attempts.length : 0,
          cancelledAt: execution?.cancelledAt ?? null,
          // Just the count here. A run picker needs to know an answer arrived
          // and was thrown away; what it was belongs on the run itself.
          discardedCount: Array.isArray(execution?.discarded) ? execution.discarded.length : 0,
          counts: execution?.counts ?? null,
          triggerKind: execution?.triggerKind ?? null,
          triggeredBy: names.get(execution?.triggeredByUserId) || null
        };
      })
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

    const entries = await pipelineRuns.runsForStep(req.params.id, round, jobType, { metadataOnly: true });
    if (entries.length === 0) throw new NotFoundError(`Runs for ${jobType}`);

    const entry = await pipelineRuns.stepInRun(req.params.id, round, jobType, runNumber);
    if (!entry) throw new NotFoundError(`Run ${runNumber} of ${jobType}`);
    if (!entry.execution) {
      // The run contains the step and the step has not executed in it. Not a
      // 404 — the run is real and the answer is "nothing yet", which a spinner
      // waiting for a run that will never load cannot say.
      return res.json({
        run: {
          jobType, round, runNumber, runCount: entries.length,
          isLatest: runNumber === entries[0].runNumber,
          status: 'not_started', carriedOver: entry.carriedOver, cause: entry.cause,
          result: null, logs: [], files: {}, inputs: null, documents: {}
        }
      });
    }

    res.json({
      run: shapeRun(entry.execution, {
        runCount: entries.length,
        triggeredBy: await resolveTrigger(entry.execution.triggeredByUserId),
        // Newest-first, so the first entry is the current run.
        isLatest: runNumber === entries[0].runNumber,
        // Which run number the user asked for, and whether the result they are
        // about to read was actually produced by a different one.
        runNumber,
        carriedOver: entry.carriedOver,
        producedByRun: entry.producedByRun,
        cause: entry.cause,
        paramsSource: entry.paramsSource,
        cancelledBy: await resolveTrigger(entry.execution.cancelledByUserId)
      })
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Every pipeline run of this round, and what each one contains.
 * GET /api/submissions/:id/runs
 *
 * The submission-wide view: "show me run 2" as ONE number across every module,
 * rather than a different number per module displayed in the same place. This
 * is what a run being the unit of the model buys, and it is not derivable from
 * the per-step endpoints — those can say what happened to a step across runs,
 * and cannot say what a run did.
 *
 * Metadata only, and deliberately: a round with a dozen runs would otherwise
 * fetch every payload of every step to draw a list.
 */
async function listPipelineRuns(req, res, next) {
  try {
    const round = resolveRound(req);
    const runs = await pipelineRuns.runsForSubmission(req.params.id, round);
    res.json({ round, runCount: runs.length, runs });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getJobs,
  listPipelineRuns,
  runProcesses,
  restartProcesses,
  retryJob,
  continueWithoutJob,
  advanceJob,
  cancelProcessing,
  getJobResponse,
  getJobPrompts,
  listRuns,
  getRun
};
