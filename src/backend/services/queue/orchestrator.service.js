/**
 * Process Orchestrator
 *
 * Manages the execution order of background processes for a submission.
 * Defines a pipeline with dependencies — jobs only start when their
 * dependencies have reached a terminal state (complete or failed).
 */

const { sequelize, SubmissionJob } = require('../../models');
const { JOB_TYPES } = require('../../config/constants');
const jobQueue = require('./job-queue.service');
const logger = require('../../utils/logger');

/**
 * Pipeline definition — single source of truth for process ordering.
 *
 * Each entry: { jobType, dependsOn: [...jobTypes], canAutoAdvance? }
 * Jobs with no dependencies start immediately.
 * Jobs with dependencies start when ALL dependencies reach a terminal state.
 *
 * canAutoAdvance(dependencyJobs): optional function.
 *   - Returns true → job is enqueued automatically.
 *   - Returns false → job is set to 'pending_input' (needs manual advance).
 *   - Omitted → always auto-advances.
 */
const PIPELINE = [
  { jobType: JOB_TYPES.DAS_EXTRACTION,     dependsOn: [] },
  { jobType: JOB_TYPES.SOFTWARE_DETECTION,  dependsOn: [] },
  { jobType: JOB_TYPES.ORCID_EXTRACTION,   dependsOn: [] },
  { jobType: JOB_TYPES.MARKDOWN_CONVERT,   dependsOn: [] },
  { jobType: JOB_TYPES.DATASETS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT] },
  { jobType: JOB_TYPES.MATERIALS_DETECTION, dependsOn: [] },
  { jobType: JOB_TYPES.PROTOCOLS_DETECTION, dependsOn: [JOB_TYPES.MARKDOWN_CONVERT] },
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
  }
];

/**
 * Map jobType to the queue name used by pg-boss
 */
const JOB_TYPE_TO_QUEUE = {
  [JOB_TYPES.PDF_ANALYSIS]:       jobQueue.QUEUES.PDF_ANALYSIS,
  [JOB_TYPES.DAS_EXTRACTION]:     jobQueue.QUEUES.DAS_EXTRACTION,
  [JOB_TYPES.SOFTWARE_DETECTION]: jobQueue.QUEUES.SOFTWARE_DETECTION,
  [JOB_TYPES.ORCID_EXTRACTION]:  jobQueue.QUEUES.ORCID_EXTRACTION,
  [JOB_TYPES.MARKDOWN_CONVERT]:   jobQueue.QUEUES.MARKDOWN_CONVERT,
  [JOB_TYPES.DATASETS_DETECTION]: jobQueue.QUEUES.DATASETS_DETECTION,
  [JOB_TYPES.MATERIALS_DETECTION]: jobQueue.QUEUES.MATERIALS_DETECTION,
  [JOB_TYPES.PROTOCOLS_DETECTION]: jobQueue.QUEUES.PROTOCOLS_DETECTION,
  [JOB_TYPES.IDENTIFIER_DETECTION]: jobQueue.QUEUES.IDENTIFIER_DETECTION
};

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

  for (const step of dependentSteps) {
    const job = jobsByType.get(step.jobType);
    if (!job || job.status !== 'waiting') continue;

    // Check if ALL dependencies are in a terminal state
    const allDependenciesDone = step.dependsOn.every(depType => {
      const depJob = jobsByType.get(depType);
      return depJob && (depJob.status === 'complete' || depJob.status === 'failed');
    });

    if (!allDependenciesDone) continue;

    // Check if this step has a conditional gate
    if (step.canAutoAdvance && !step.canAutoAdvance(jobsByType)) {
      // Gate condition not met — park job as pending_input
      await job.markPendingInput({ reason: 'Auto-advance condition not met' });

      logger.info('Pipeline paused: job needs user input', {
        submissionId,
        jobType: step.jobType,
        triggeredBy: completedJobType
      });
      continue;
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
      triggeredBy: completedJobType
    });
  }
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
    throw new Error(`No ${jobType} job found for submission ${submissionId} round ${round}`);
  }

  if (job.status !== 'pending_input') {
    throw new Error(`Job ${jobType} is '${job.status}', expected 'pending_input'`);
  }

  const queueName = JOB_TYPE_TO_QUEUE[jobType];
  if (!queueName) {
    throw new Error(`Unknown job type: ${jobType}`);
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

module.exports = {
  PIPELINE,
  runAllProcesses,
  checkAndAdvance,
  advanceJob,
  cascadeRestart,
  computeDownstreamSet
};
