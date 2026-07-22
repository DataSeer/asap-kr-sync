/**
 * Process Orchestrator
 *
 * Manages the execution order of background processes for a submission.
 * Defines a pipeline with dependencies — jobs only start when their
 * dependencies have reached a terminal state (complete or failed).
 */

const { Op } = require('sequelize');
const { sequelize, SubmissionJob, Submission } = require('../../models');
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ConflictError, ValidationError } = require('../../utils/errors');
const jobQueue = require('./job-queue.service');
const logger = require('../../utils/logger');

// Jobs younger than this are left alone by the reconciler — their dependencies
// may simply still be running, and we don't want to race a checkAndAdvance that
// just fired. A dropped advancement will still be older than this by the time
// the periodic sweep runs.
const RECONCILE_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Pipeline definition — single source of truth for process ordering.
 *
 * Each entry: { jobType, dependsOn: [...jobTypes], canAutoAdvance?, gate? }
 * Jobs with no dependencies start immediately.
 * Jobs with dependencies start when ALL dependencies reach a terminal state.
 *
 * canAutoAdvance(dependencyJobs): optional function.
 *   - Returns true → job is enqueued automatically.
 *   - Returns false → job is set to 'pending_input' (needs manual advance).
 *   - Omitted → always auto-advances.
 *
 * gate: optional name of a submission-state condition (see GATES). Unlike
 * canAutoAdvance (which parks the job as pending_input for a manual decision),
 * an unsatisfied gate keeps the job in `waiting`: it advances automatically
 * when the submission state changes (status-change handler and the periodic
 * reconciler both re-drive the pipeline).
 */

/**
 * Submission-state gates, by name. Each receives the Submission (id, status)
 * and returns whether the gated step may start.
 */
const GATES = {
  // The author KRT feeds the seeded detectors (datasets/materials/protocols
  // load author rows as LM seeds), so those must not run until the author has
  // finished curating the KRT — i.e. the submission has moved past the KRT
  // step. draft/step_krt = still curating.
  krt_curated: (submission) => !['draft', 'step_krt'].includes(submission.status)
};
const PIPELINE = [
  // DAS extraction now reads the converted markdown (Gemini-based, replaces
  // the Modal Llama fine-tune that ate the PDF directly), so it depends on
  // MARKDOWN_CONVERT just like the other Gemini-based detectors.
  { jobType: JOB_TYPES.DAS_EXTRACTION,     dependsOn: [JOB_TYPES.MARKDOWN_CONVERT] },
  { jobType: JOB_TYPES.SOFTWARE_DETECTION,  dependsOn: [] },
  { jobType: JOB_TYPES.ORCID_EXTRACTION,   dependsOn: [] },
  { jobType: JOB_TYPES.MARKDOWN_CONVERT,   dependsOn: [] },
  // The three seeded detectors read the author KRT (seeds for the LM prompt),
  // so they additionally gate on the author having validated the KRT step.
  // Software/ORCID/DAS/identifier detection don't consume author KRT data and
  // keep starting as early as their job dependencies allow.
  { jobType: JOB_TYPES.DATASETS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: 'krt_curated' },
  { jobType: JOB_TYPES.MATERIALS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: 'krt_curated' },
  { jobType: JOB_TYPES.PROTOCOLS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT], gate: 'krt_curated' },
  // Identifier detection scans the post-conversion markdown against the
  // curated enrichment list. Cross-category — produces software/materials/
  // datasets/protocols items in one pass and lets pdf-analysis consolidate.
  { jobType: JOB_TYPES.IDENTIFIER_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT] },
  {
    // PDF Analysis is the consolidator: it merges every detection's items
    // into the Generated KRT. So it depends on every detection that
    // contributes resources (DAS is kept as a soft gate via canAutoAdvance).
    jobType: JOB_TYPES.PDF_ANALYSIS,
    dependsOn: [
      JOB_TYPES.DAS_EXTRACTION,
      JOB_TYPES.SOFTWARE_DETECTION,
      JOB_TYPES.DATASETS_DETECTION,
      JOB_TYPES.MATERIALS_DETECTION,
      JOB_TYPES.PROTOCOLS_DETECTION,
      JOB_TYPES.IDENTIFIER_DETECTION
    ],
    canAutoAdvance(dependencyJobs) {
      const dasJob = dependencyJobs.get(JOB_TYPES.DAS_EXTRACTION);
      // Auto-advance only if DAS was actually extracted (existing gate)
      return dasJob?.result?.status?.detected === true;
    }
  },
  {
    // LM comparison of author KRT vs Generated KRT → suggestions. Runs after
    // PDF_ANALYSIS, which already gates on every KRT detector, so the Generated
    // KRT is complete by the time this starts (ORCID is author metadata, not a
    // KRT contributor, so it isn't a dependency). Also re-triggerable on demand.
    jobType: JOB_TYPES.SUGGESTION_GENERATION,
    dependsOn: [JOB_TYPES.PDF_ANALYSIS]
  }
  // NOTE: DAS_SUGGESTIONS is intentionally NOT in the auto pipeline. It is a
  // standalone, re-triggerable job started by the /availability view once the
  // user has finished review (so the DAS is extracted and the KRT is final).
  // Keeping it out of the pipeline avoids it sitting in `waiting` and blocking
  // the earlier steps' "all processes finished" gate.
];

// Map jobType to the queue name used by pg-boss — shared, derived map so it
// can't drift from JOB_TYPES/QUEUES (a hand-written copy here went stale).
const { JOB_TYPE_TO_QUEUE } = jobQueue;

/**
 * Run all pipeline processes for a submission.
 * Creates SubmissionJob records for all pipeline steps, then enqueues
 * only the ones with no dependencies. The rest get status 'waiting'.
 *
 * @param {string} submissionId
 * @param {string} userId
 * @param {number} round
 * @returns {Promise<object[]>} Created SubmissionJob records
 */
async function runAllProcesses(submissionId, userId, round) {
  const jobs = [];

  for (const step of PIPELINE) {
    const hasDependencies = step.dependsOn.length > 0;
    const initialStatus = hasDependencies ? 'waiting' : 'queued';

    // Create the tracking record
    const submissionJob = await SubmissionJob.create({
      submissionId,
      jobType: step.jobType,
      status: initialStatus,
      round
    });

    // Only enqueue jobs with no dependencies
    if (!hasDependencies) {
      const queueName = JOB_TYPE_TO_QUEUE[step.jobType];
      const jobData = buildJobData(step.jobType, submissionId, userId, submissionJob);

      const pgBossJobId = await jobQueue.addJob(queueName, jobData);
      submissionJob.pgBossJobId = pgBossJobId;
      await submissionJob.save();
    }

    jobs.push(submissionJob);
  }

  logger.info('Pipeline started', {
    submissionId,
    round,
    jobs: jobs.map(j => ({ type: j.jobType, status: j.status }))
  });

  return jobs;
}

/**
 * Check if any waiting jobs can now be advanced to queued.
 * Called by workers after a job completes or fails.
 *
 * @param {string} submissionId
 * @param {string} completedJobType - The job type that just finished
 * @param {number} round
 * @param {string} userId - Needed for jobs that require it (e.g., PDF analysis)
 */
async function checkAndAdvance(submissionId, completedJobType, round, userId) {
  // Find pipeline steps that depend on the completed job type
  const dependentSteps = PIPELINE.filter(
    step => step.dependsOn.includes(completedJobType)
  );

  if (dependentSteps.length === 0) return;

  // Get all current jobs for this submission/round
  const allJobs = await SubmissionJob.getForSubmission(submissionId, round);
  const jobsByType = new Map(allJobs.map(j => [j.jobType, j]));

  // Submission state is needed to evaluate step gates
  const submission = await Submission.findByPk(submissionId, {
    attributes: ['id', 'status']
  });

  for (const step of dependentSteps) {
    await tryAdvanceStep(step, jobsByType, submission, submissionId, round, userId, completedJobType);
  }
}

/**
 * Attempt to advance a single waiting pipeline step. Shared by checkAndAdvance
 * (fired by a worker when its job finishes) and reconcileSubmission (the
 * periodic safety-net sweep). Idempotent: only acts on a `waiting` job whose
 * dependencies are all terminal, so calling it repeatedly is safe.
 *
 * @returns {Promise<boolean>} true if the job was enqueued
 */
async function tryAdvanceStep(step, jobsByType, submission, submissionId, round, userId, triggeredBy) {
  const job = jobsByType.get(step.jobType);
  // Only a job still 'waiting' can advance. A cancelled job is terminal (status
  // 'cancelled', not 'waiting'), so it is never started here — that is what stops
  // the pipeline after a cancel, without a separate run-level gate that would
  // also block a later restart. A restart replaces the row with a fresh
  // 'waiting'/'queued' one (getForSubmission returns the latest), which then
  // advances normally.
  if (!job || job.status !== 'waiting') return false;

  // Check if ALL dependencies are in a terminal state
  const allDependenciesDone = step.dependsOn.every(depType => {
    const depJob = jobsByType.get(depType);
    return depJob && (depJob.status === 'complete' || depJob.status === 'failed');
  });

  if (!allDependenciesDone) return false;

  // Submission-state gate: unsatisfied → stay `waiting` (NOT pending_input);
  // the status-change handler / reconciler re-drives once the state changes.
  // Debug level: the reconciler sweep re-checks gated jobs every interval and
  // an info log per sweep per job would be pure noise.
  if (step.gate && GATES[step.gate] && submission && !GATES[step.gate](submission)) {
    logger.debug('Pipeline step gated, staying in waiting', {
      submissionId, jobType: step.jobType, gate: step.gate,
      submissionStatus: submission.status, triggeredBy
    });
    return false;
  }

  // Check if this step has a conditional gate
  if (step.canAutoAdvance && !step.canAutoAdvance(jobsByType)) {
    // Gate condition not met — park job as pending_input
    await job.markPendingInput({ reason: 'Auto-advance condition not met' });

    logger.info('Pipeline paused: job needs user input', {
      submissionId,
      jobType: step.jobType,
      triggeredBy
    });
    return false;
  }

  // All dependencies met and gate passed — enqueue this job
  const queueName = JOB_TYPE_TO_QUEUE[step.jobType];
  const jobData = buildJobData(step.jobType, submissionId, userId, job);

  const pgBossJobId = await jobQueue.addJob(queueName, jobData);
  job.status = 'queued';
  job.pgBossJobId = pgBossJobId;
  await job.save();

  logger.info('Pipeline advanced: job enqueued', {
    submissionId,
    jobType: step.jobType,
    triggeredBy
  });
  return true;
}

/**
 * Re-drive every waiting step of one submission/round whose dependencies are
 * already terminal. Used by the reconciler to recover a pipeline whose
 * advancement was dropped (e.g. a transient DB/queue error inside
 * checkAndAdvance) and would otherwise hang in `waiting` forever.
 *
 * @returns {Promise<number>} number of jobs enqueued
 */
async function reconcileSubmission(submissionId, round, userId, submission = null) {
  const allJobs = await SubmissionJob.getForSubmission(submissionId, round);
  const jobsByType = new Map(allJobs.map(j => [j.jobType, j]));

  const sub = submission || await Submission.findByPk(submissionId, {
    attributes: ['id', 'status']
  });

  let advanced = 0;
  for (const step of PIPELINE) {
    const didAdvance = await tryAdvanceStep(
      step, jobsByType, sub, submissionId, round, userId, 'reconciler'
    );
    if (didAdvance) advanced++;
  }
  return advanced;
}

/**
 * Safety-net sweep: find jobs stuck in `waiting` (older than the grace window)
 * and re-drive their submission's pipeline. checkAndAdvance is the primary
 * advancement path; this guarantees that even if an advancement was dropped,
 * a stuck submission self-heals within one sweep interval instead of hanging.
 *
 * @param {{ graceMs?: number }} [opts]
 * @returns {Promise<number>} total jobs re-driven across all submissions
 */
async function reconcileStuckJobs({ graceMs = RECONCILE_GRACE_MS } = {}) {
  const cutoff = new Date(Date.now() - graceMs);

  // Distinct (submission, round) pairs that have at least one long-waiting job.
  const stuck = await SubmissionJob.findAll({
    where: { status: 'waiting', createdAt: { [Op.lt]: cutoff } },
    attributes: ['submissionId', 'round'],
    group: ['submissionId', 'round'],
    raw: true
  });

  if (stuck.length === 0) return 0;

  let advancedTotal = 0;
  for (const { submissionId, round } of stuck) {
    const submission = await Submission.findByPk(submissionId, {
      attributes: ['id', 'userId', 'status']
    });
    if (!submission) continue;

    try {
      advancedTotal += await reconcileSubmission(submissionId, round, submission.userId, submission);
    } catch (err) {
      logger.error('Pipeline reconciler failed for submission', {
        submissionId, round, error: err.message
      });
    }
  }

  if (advancedTotal > 0) {
    logger.warn('Pipeline reconciler re-drove stuck jobs', {
      submissions: stuck.length,
      advanced: advancedTotal
    });
  }
  return advancedTotal;
}

/**
 * Manually advance a job from 'pending_input' to 'queued'.
 * Used when the user has provided the required input (e.g., manually entered DAS).
 *
 * @param {string} submissionId
 * @param {string} jobType - The job type to advance
 * @param {number} round
 * @param {string} userId
 * @returns {Promise<object>} The updated SubmissionJob
 */
async function advanceJob(submissionId, jobType, round, userId) {
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);

  if (!job) {
    throw new NotFoundError(`${jobType} job`);
  }

  // Idempotent: if the job has already moved past pending_input, treat advance
  // as a no-op success — the desired outcome (job running or done) is already
  // achieved. This avoids 500s when the UI fires a redundant advance (e.g. the
  // shared Edit-Metadata modal closing on a submission whose analysis finished).
  if (['queued', 'processing', 'complete'].includes(job.status)) {
    logger.info('Advance is a no-op: job already advanced', {
      submissionId, jobType, round, status: job.status
    });
    return job;
  }

  if (job.status !== 'pending_input') {
    // 'waiting' (dependencies not finished) or 'failed' — cannot advance.
    throw new ConflictError(`Cannot advance ${jobType}: job is '${job.status}', not awaiting input`);
  }

  const queueName = JOB_TYPE_TO_QUEUE[jobType];
  if (!queueName) {
    throw new ValidationError(`Unknown job type: ${jobType}`);
  }

  const jobData = buildJobData(jobType, submissionId, userId, job);
  const pgBossJobId = await jobQueue.addJob(queueName, jobData);

  job.status = 'queued';
  job.pgBossJobId = pgBossJobId;
  await job.save();

  logger.info('Pipeline advanced manually: job enqueued', {
    submissionId,
    jobType,
    round
  });

  return job;
}

/**
 * Build the job data payload for a specific job type.
 * @param {string} jobType
 * @param {string} submissionId
 * @param {string} userId
 * @param {object} submissionJob - The SubmissionJob record
 * @returns {object}
 */
function buildJobData(jobType, submissionId, userId, submissionJob) {
  const base = { submissionId, submissionJobId: submissionJob.id };

  switch (jobType) {
    case JOB_TYPES.PDF_ANALYSIS:
      return { ...base, userId };
    case JOB_TYPES.DAS_EXTRACTION:
      return base;
    case JOB_TYPES.SOFTWARE_DETECTION:
      return base;
    case JOB_TYPES.ORCID_EXTRACTION:
      return base;
    case JOB_TYPES.MARKDOWN_CONVERT:
      return base;
    case JOB_TYPES.DATASETS_DETECTION:
      return base;
    case JOB_TYPES.MATERIALS_DETECTION:
      return base;
    case JOB_TYPES.PROTOCOLS_DETECTION:
      return base;
    case JOB_TYPES.IDENTIFIER_DETECTION:
      return base;
    default:
      return base;
  }
}

/**
 * Compute the set of job types that transitively depend on `rootJobType`.
 * If A depends on rootJobType, and B depends on A, both A and B are downstream.
 *
 * @param {string} rootJobType
 * @returns {Set<string>}
 */
function computeDownstreamSet(rootJobType) {
  const downstream = new Set();
  let frontier = new Set([rootJobType]);
  while (frontier.size > 0) {
    const next = new Set();
    for (const step of PIPELINE) {
      if (step.dependsOn.some(dep => frontier.has(dep)) && !downstream.has(step.jobType)) {
        downstream.add(step.jobType);
        next.add(step.jobType);
      }
    }
    frontier = next;
  }
  return downstream;
}

/**
 * Cascade-restart: when a process is being re-run, every downstream process
 * that depends on it (transitively) needs to be reset to `waiting` so it gets
 * re-queued by checkAndAdvance once this restart completes. Without this, the
 * downstream processes would still hold stale results from the previous run.
 *
 * Resets the LATEST SubmissionJob of each downstream type (in this round) to
 * `waiting` if it's currently in a terminal state (`complete` or `failed`).
 * Jobs that are already `queued` or `processing` are left alone (will pick up
 * fresh inputs when they run).
 *
 * @param {string} submissionId
 * @param {string} restartedJobType - The jobType being re-run.
 * @param {number} round
 * @returns {Promise<string[]>} List of jobTypes that were reset.
 */
async function cascadeRestart(submissionId, restartedJobType, round) {
  const downstream = computeDownstreamSet(restartedJobType);
  if (downstream.size === 0) return [];

  // Atomic + serialized: SELECT ... FOR UPDATE on each downstream job row
  // serializes against any concurrent checkAndAdvance reading the same rows,
  // and wrapping the loop in one transaction makes the multi-row reset
  // observable as a single state change.
  return sequelize.transaction(async (t) => {
    const reset = [];
    for (const jobType of downstream) {
      const where = { submissionId, jobType };
      if (round !== undefined) where.round = round;
      const job = await SubmissionJob.findOne({
        where,
        order: [['createdAt', 'DESC']],
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!job) continue;
      if (job.status === 'queued' || job.status === 'processing') continue;
      job.status = 'waiting';
      job.pgBossJobId = null;
      await job.save({ transaction: t });
      reset.push(jobType);
    }

    if (reset.length > 0) {
      logger.info('Cascade restart: downstream jobs reset to waiting', {
        submissionId, restartedJobType, round, resetJobTypes: reset
      });
    }
    return reset;
  });
}

/**
 * Whether a job type is currently blocked by its submission-state gate.
 * Used by the jobs API to explain WHY a job is `waiting` (the frontend shows
 * "waiting for KRT validation" instead of a generic dependency message).
 * @param {string} jobType
 * @param {object} submission - needs `status`
 * @returns {boolean}
 */
function isGateBlocked(jobType, submission) {
  const step = PIPELINE.find(s => s.jobType === jobType);
  if (!step || !step.gate || !GATES[step.gate]) return false;
  return !GATES[step.gate](submission);
}

module.exports = {
  PIPELINE,
  runAllProcesses,
  checkAndAdvance,
  reconcileSubmission,
  reconcileStuckJobs,
  advanceJob,
  cascadeRestart,
  computeDownstreamSet,
  isGateBlocked
};
