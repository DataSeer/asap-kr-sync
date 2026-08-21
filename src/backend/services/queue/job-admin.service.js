/**
 * Job administration — inspect and clean up the processing queue.
 *
 * The pipeline is fail-soft by design: a job that cannot progress parks in
 * `waiting` rather than erroring, and pg-boss retries transient failures. That
 * is right for a single submission and wrong in aggregate — over time the queue
 * accumulates work that will never produce anything useful: jobs whose
 * submission was deleted, jobs waiting on a dependency that failed permanently,
 * jobs superseded by a later re-run of the same step. They still occupy worker
 * slots and still make the panel look busy.
 *
 * This module classifies that backlog and lets an operator clear it.
 *
 * Two safety rules run through everything here:
 *
 *   1. **A running job is never touched implicitly.** `processing` means a
 *      worker holds it right now; killing the row would orphan the work and
 *      confuse its completion handler. Cancelling one is possible but must be
 *      asked for explicitly.
 *   2. **Deleting a row also cancels its pg-boss job.** Otherwise the queue
 *      entry survives, fires later, finds no SubmissionJob, and fails — turning
 *      a cleanup into a new source of noise.
 */

const { Op } = require('sequelize');
const jobQueue = require('./job-queue.service');
const { JOB_TYPES, JOB_STATUSES } = require('../../config/constants');
const logger = require('../../utils/logger');

/** A `waiting` job older than this is very unlikely to ever advance. */
const STUCK_WAITING_HOURS = 6;

/** `queued`/`processing` older than this suggests a worker died holding it. */
const STALE_ACTIVE_HOURS = 2;

/** Statuses that are finished — nothing will change them again. */
const TERMINAL_STATUSES = ['complete', 'failed', 'cancelled'];

/**
 * Why a job is considered no longer viable. `null` means it looks healthy.
 *
 * Ordered by confidence: `orphaned` is certain (the submission is gone),
 * `superseded` is certain (a newer run of the same step exists), the two
 * age-based ones are heuristics an operator should eyeball before acting.
 */
const STALE_REASONS = {
  orphaned: 'The submission this job belongs to no longer exists.',
  superseded: 'A newer run of the same step exists for this submission and round.',
  stuck_waiting: `Waiting for more than ${STUCK_WAITING_HOURS}h — its dependencies are unlikely to complete.`,
  stale_active: `Queued or processing for more than ${STALE_ACTIVE_HOURS}h — the worker holding it probably died.`
};

/**
 * Classify one job against its siblings.
 *
 * @param {object} job - plain SubmissionJob row (needs status, jobType, round, createdAt, updatedAt)
 * @param {boolean} submissionExists
 * @param {Map<string, string>} newestByKey - `${submissionId}|${jobType}|${round}` → newest job id
 * @param {number} now - epoch ms
 * @returns {string|null} a key of STALE_REASONS, or null when the job looks fine
 */
function classifyJob(job, submissionExists, newestByKey, now) {
  if (!submissionExists) return 'orphaned';

  // A finished job is history, not backlog — never stale. This has to come
  // BEFORE the superseded check: every manual re-run creates a fresh row, so
  // testing "is this the newest?" first labelled the previous SUCCESSFUL run
  // superseded, and `deleteStaleJobs` then deleted it along with its logs and
  // its artefact references. What "superseded" is for is an unfinished job that
  // a newer run has replaced.
  if (TERMINAL_STATUSES.includes(job.status)) return null;

  const key = `${job.submissionId}|${job.jobType}|${job.round}`;
  if (newestByKey.get(key) !== job.id) return 'superseded';

  const ageMs = now - new Date(job.updatedAt || job.createdAt).getTime();
  if (job.status === 'waiting' && ageMs > STUCK_WAITING_HOURS * 3600_000) return 'stuck_waiting';
  if (['queued', 'processing'].includes(job.status) && ageMs > STALE_ACTIVE_HOURS * 3600_000) {
    return 'stale_active';
  }

  return null;
}

/**
 * List jobs across every submission, annotated with a staleness verdict.
 *
 * @param {object} [filters]
 * @param {string}  [filters.status]      - one JOB_STATUSES value
 * @param {string}  [filters.jobType]     - one JOB_TYPES value
 * @param {string}  [filters.submissionId]
 * @param {string}  [filters.staleReason] - a STALE_REASONS key, or 'any'
 * @param {number}  [filters.limit=200]
 * @param {number}  [filters.offset=0]
 * @returns {Promise<{ jobs: object[], total: number, stats: object }>}
 */
async function listJobs(filters = {}) {
  const { SubmissionJob, Submission } = require('../../models');
  const {
    status, jobType, submissionId, staleReason,
    limit = 200, offset = 0
  } = filters;

  const where = {};
  if (status) where.status = status;
  if (jobType) where.jobType = jobType;
  if (submissionId) where.submissionId = submissionId;

  // The staleness verdict is relative to a job's siblings, so classification
  // needs every job of the matching submissions — not just the current page.
  const all = await SubmissionJob.findAll({
    where,
    order: [['createdAt', 'DESC']],
    raw: true
  });

  const submissionIds = [...new Set(all.map((j) => j.submissionId))];
  const submissions = await Submission.findAll({
    where: { id: { [Op.in]: submissionIds.length > 0 ? submissionIds : [null] } },
    attributes: ['id', 'manuscriptId', 'title', 'status'],
    raw: true
  });
  const submissionById = new Map(submissions.map((s) => [s.id, s]));

  // Newest job per (submission, jobType, round) — `all` is already newest-first.
  const newestByKey = new Map();
  for (const job of all) {
    const key = `${job.submissionId}|${job.jobType}|${job.round}`;
    if (!newestByKey.has(key)) newestByKey.set(key, job.id);
  }

  const now = Date.now();
  const annotated = all.map((job) => {
    const submission = submissionById.get(job.submissionId) || null;
    const reason = classifyJob(job, !!submission, newestByKey, now);
    return {
      id: job.id,
      submissionId: job.submissionId,
      manuscriptId: submission?.manuscriptId || null,
      submissionTitle: submission?.title || null,
      submissionStatus: submission?.status || null,
      submissionExists: !!submission,
      jobType: job.jobType,
      status: job.status,
      round: job.round,
      retryCount: job.retryCount,
      pgBossJobId: job.pgBossJobId,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      staleReason: reason,
      staleDescription: reason ? STALE_REASONS[reason] : null,
      // A running job is protected from bulk actions.
      deletable: job.status !== 'processing'
    };
  });

  const filtered = staleReason
    ? annotated.filter((j) => (staleReason === 'any' ? !!j.staleReason : j.staleReason === staleReason))
    : annotated;

  return {
    jobs: filtered.slice(offset, offset + limit),
    total: filtered.length,
    stats: buildStats(annotated)
  };
}

/**
 * Roll the annotated set up into the counters the page header shows.
 * @param {object[]} annotated
 * @returns {object}
 */
function buildStats(annotated) {
  const byStatus = {};
  const byStaleReason = {};
  for (const job of annotated) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    if (job.staleReason) byStaleReason[job.staleReason] = (byStaleReason[job.staleReason] || 0) + 1;
  }
  return {
    total: annotated.length,
    stale: annotated.filter((j) => j.staleReason).length,
    running: annotated.filter((j) => j.status === 'processing').length,
    byStatus,
    byStaleReason
  };
}

/**
 * Remove a job's pg-boss queue entry so a deleted row cannot leave live work
 * behind. Best-effort: an entry that already completed or expired is simply not
 * there, which is not an error worth failing the delete over.
 *
 * @param {object} job - SubmissionJob instance or plain row
 * @returns {Promise<boolean>} whether a queue entry was cancelled
 */
async function cancelQueueEntry(job) {
  if (!job?.pgBossJobId) return false;
  const queueName = jobQueue.JOB_TYPE_TO_QUEUE[job.jobType];
  if (!queueName) return false;
  try {
    await jobQueue.cancelJob(queueName, job.pgBossJobId);
    return true;
  } catch (error) {
    logger.warn('Could not cancel pg-boss entry while deleting a job', {
      jobId: job.id, queueName, pgBossJobId: job.pgBossJobId, error: error.message
    });
    return false;
  }
}

/**
 * Cancel every queued pg-boss entry belonging to a submission.
 *
 * `submission_jobs.submission_id` is `ON DELETE CASCADE`, so deleting a
 * submission removes its job ROWS — but pg-boss keeps its own table with no
 * foreign key to anything of ours, so the QUEUE ENTRIES survive. A worker then
 * picks one up, looks up a submission that no longer exists, and logs
 * "Submission not found". Once per entry, times the retry limit.
 *
 * Call this BEFORE destroying a submission, while its jobs are still readable.
 *
 * @param {string} submissionId
 * @returns {Promise<number>} how many queue entries were cancelled
 */
async function cancelQueuedJobsForSubmission(submissionId) {
  const { SubmissionJob } = require('../../models');
  const jobs = await SubmissionJob.findAll({
    where: { submissionId, status: { [Op.in]: ['waiting', 'queued', 'processing', 'pending_input'] } }
  });

  let cancelled = 0;
  for (const job of jobs) {
    if (await cancelQueueEntry(job)) cancelled++;
  }
  if (cancelled > 0) {
    logger.info('Cancelled queued jobs for a submission being deleted', { submissionId, cancelled });
  }
  return cancelled;
}

/**
 * Find pg-boss queue entries whose SubmissionJob row is gone.
 *
 * These are invisible to `listJobs`, which reads `submission_jobs`: the row is
 * exactly what has been deleted. They are the residue of submissions removed
 * before `cancelQueuedJobsForSubmission` existed, and they keep failing until
 * the queue drops them.
 *
 * Reads the pg-boss schema directly — pg-boss's own API has no "list jobs by
 * predicate" call. Guarded to the states that can still run.
 *
 * @returns {Promise<{ id: string, name: string, state: string, submissionId: string|null, createdOn: string }[]>}
 */
async function findOrphanedQueueEntries() {
  const { sequelize } = require('../../models');
  const [rows] = await sequelize.query(`
    SELECT j.id::text            AS id,
           j.name                AS name,
           j.state::text         AS state,
           j.data->>'submissionId' AS "submissionId",
           j.createdon           AS "createdOn"
    FROM pgboss.job j
    WHERE j.state IN ('created', 'retry')
      AND j.data ? 'submissionJobId'
      AND NOT EXISTS (
        SELECT 1 FROM submission_jobs sj
        WHERE sj.id::text = j.data->>'submissionJobId'
      )
    ORDER BY j.createdon ASC
  `);
  return rows;
}

/**
 * Cancel every orphaned queue entry found by findOrphanedQueueEntries.
 *
 * Cancels rather than deletes: pg-boss has a terminal `cancelled` state, and
 * keeping the row preserves the audit trail its own maintenance will clear.
 *
 * @returns {Promise<{ cancelled: number, entries: object[] }>}
 */
async function purgeOrphanedQueueEntries() {
  const { sequelize } = require('../../models');
  const entries = await findOrphanedQueueEntries();
  if (entries.length === 0) return { cancelled: 0, entries: [] };

  const [, meta] = await sequelize.query(`
    UPDATE pgboss.job
    SET state = 'cancelled', completedon = now()
    WHERE state IN ('created', 'retry')
      AND data ? 'submissionJobId'
      AND NOT EXISTS (
        SELECT 1 FROM submission_jobs sj
        WHERE sj.id::text = data->>'submissionJobId'
      )
  `);

  const cancelled = meta?.rowCount ?? entries.length;
  logger.info('Purged orphaned pg-boss queue entries', { cancelled });
  return { cancelled, entries };
}

/**
 * Delete jobs by id.
 *
 * @param {string[]} ids
 * @param {object} [options]
 * @param {boolean} [options.includeProcessing=false] - allow deleting a job a
 *   worker currently holds. Off by default; the caller must opt in per request.
 * @returns {Promise<{ deleted: number, skipped: object[], cancelledQueueEntries: number }>}
 */
async function deleteJobs(ids, { includeProcessing = false } = {}) {
  const { SubmissionJob } = require('../../models');
  const wanted = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (wanted.length === 0) return { deleted: 0, skipped: [], cancelledQueueEntries: 0 };

  const jobs = await SubmissionJob.findAll({ where: { id: { [Op.in]: wanted } } });

  const skipped = [];
  const deletable = [];
  for (const job of jobs) {
    if (job.status === 'processing' && !includeProcessing) {
      skipped.push({ id: job.id, reason: 'A worker is running this job right now.' });
      continue;
    }
    deletable.push(job);
  }

  // Missing ids are reported rather than silently counted as deleted.
  const foundIds = new Set(jobs.map((j) => j.id));
  for (const id of wanted) {
    if (!foundIds.has(id)) skipped.push({ id, reason: 'No such job (already deleted?).' });
  }

  let cancelledQueueEntries = 0;
  for (const job of deletable) {
    if (await cancelQueueEntry(job)) cancelledQueueEntries++;
  }

  const deleted = deletable.length > 0
    ? await SubmissionJob.destroy({ where: { id: { [Op.in]: deletable.map((j) => j.id) } } })
    : 0;

  logger.info('Admin deleted processing jobs', {
    requested: wanted.length, deleted, skipped: skipped.length, cancelledQueueEntries
  });

  return { deleted, skipped, cancelledQueueEntries };
}

/**
 * Delete every job currently classified with a given staleness reason.
 *
 * Re-classifies at call time rather than trusting ids the page collected
 * earlier — the queue moves, and a job that has since started running must not
 * be swept up by a click made a minute ago.
 *
 * @param {string} staleReason - a STALE_REASONS key, or 'any'
 * @returns {Promise<{ deleted: number, skipped: object[], cancelledQueueEntries: number, matched: number }>}
 */
async function deleteStaleJobs(staleReason) {
  if (staleReason !== 'any' && !STALE_REASONS[staleReason]) {
    throw new Error(`Unknown staleness reason: ${staleReason}`);
  }

  const { jobs } = await listJobs({ staleReason, limit: Number.MAX_SAFE_INTEGER });
  const ids = jobs.filter((j) => j.deletable).map((j) => j.id);
  const result = await deleteJobs(ids);
  return { ...result, matched: jobs.length };
}

/**
 * Cancel a job without deleting it: the record stays for audit, the queue entry
 * goes, and the row moves to the terminal `cancelled` state so the pipeline
 * stops waiting on it.
 *
 * @param {string} id
 * @returns {Promise<object|null>} the updated job, or null when not found
 */
async function cancelJobById(id) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.findByPk(id);
  if (!job) return null;

  await cancelQueueEntry(job);
  await job.markCancelled();
  logger.info('Admin cancelled a processing job', { jobId: id, jobType: job.jobType });
  return job;
}

module.exports = {
  STALE_REASONS,
  STUCK_WAITING_HOURS,
  STALE_ACTIVE_HOURS,
  TERMINAL_STATUSES,
  JOB_TYPES,
  JOB_STATUSES,
  classifyJob,
  buildStats,
  listJobs,
  cancelQueuedJobsForSubmission,
  findOrphanedQueueEntries,
  purgeOrphanedQueueEntries,
  deleteJobs,
  deleteStaleJobs,
  cancelJobById
};
