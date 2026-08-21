/**
 * Job Administration Controller
 *
 * Operator-facing view of the whole processing queue, with cleanup actions.
 * Every route here is admin-gated in the router — these actions delete rows
 * and cancel queued work across submissions the caller does not own.
 */

const jobAdminService = require('../services/queue/job-admin.service');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * List jobs with staleness annotations.
 * GET /api/admin/jobs
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reject a filter value the database cannot be asked about.
 *
 * `status` is a Postgres enum and `submissionId` is a uuid, so a typo in the
 * admin URL reached the driver and came back as
 * `invalid input value for enum enum_submission_jobs_status: "nope"` — a 500,
 * with the database's error text, for what is plainly a bad request.
 *
 * @throws {ValidationError} listing the values that would have worked
 */
function assertAllowed(name, value, allowed) {
  if (value === undefined) return;
  if (!allowed.includes(value)) {
    throw new ValidationError(
      `Unknown ${name}: "${value}". Expected one of: ${allowed.join(', ')}`
    );
  }
}

async function listJobs(req, res, next) {
  try {
    const { status, jobType, submissionId, staleReason, limit, offset } = req.query;

    assertAllowed('status', status || undefined, jobAdminService.JOB_STATUSES);
    assertAllowed('jobType', jobType || undefined, Object.values(jobAdminService.JOB_TYPES));
    // Keys, not values: STALE_REASONS maps a token to the sentence the UI
    // shows. 'any' means "stale for whatever reason" and is not in the map.
    assertAllowed('staleReason', staleReason || undefined,
      ['any', ...Object.keys(jobAdminService.STALE_REASONS)]);
    if (submissionId && !UUID_RE.test(submissionId)) {
      throw new ValidationError(`Not a submission id: "${submissionId}"`);
    }

    const result = await jobAdminService.listJobs({
      status: status || undefined,
      jobType: jobType || undefined,
      submissionId: submissionId || undefined,
      staleReason: staleReason || undefined,
      limit: limit ? Math.min(parseInt(limit, 10) || 200, 1000) : 200,
      offset: offset ? parseInt(offset, 10) || 0 : 0
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * The filter vocabulary the page renders its dropdowns from, so the UI never
 * hardcodes a list that can drift from the backend.
 * GET /api/admin/jobs/meta
 */
async function getMeta(req, res, next) {
  try {
    res.json({
      jobTypes: Object.values(jobAdminService.JOB_TYPES),
      statuses: jobAdminService.JOB_STATUSES,
      staleReasons: jobAdminService.STALE_REASONS,
      thresholds: {
        stuckWaitingHours: jobAdminService.STUCK_WAITING_HOURS,
        staleActiveHours: jobAdminService.STALE_ACTIVE_HOURS
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete one job.
 * DELETE /api/admin/jobs/:id
 */
async function deleteJob(req, res, next) {
  try {
    const includeProcessing = req.query.force === 'true';
    const result = await jobAdminService.deleteJobs([req.params.id], { includeProcessing });

    if (result.deleted === 0) {
      const reason = result.skipped[0]?.reason || 'Job could not be deleted.';
      throw new ValidationError(reason);
    }

    logger.info('Job deleted by admin', { jobId: req.params.id, userId: req.userId });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Delete a set of jobs by id.
 * POST /api/admin/jobs/bulk-delete   { ids: [...], force?: boolean }
 */
async function bulkDelete(req, res, next) {
  try {
    const { ids, force } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('Provide a non-empty `ids` array.');
    }
    const result = await jobAdminService.deleteJobs(ids, { includeProcessing: force === true });
    logger.info('Bulk job delete by admin', {
      requested: ids.length, deleted: result.deleted, userId: req.userId
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Delete every job matching a staleness reason.
 * POST /api/admin/jobs/cleanup   { staleReason: 'orphaned' | … | 'any' }
 */
async function cleanupStale(req, res, next) {
  try {
    const { staleReason } = req.body || {};
    if (!staleReason) throw new ValidationError('Provide a `staleReason`.');

    const result = await jobAdminService.deleteStaleJobs(staleReason);
    logger.info('Stale job cleanup by admin', {
      staleReason, matched: result.matched, deleted: result.deleted, userId: req.userId
    });
    res.json(result);
  } catch (error) {
    if (error.message?.startsWith('Unknown staleness reason')) {
      return next(new ValidationError(error.message));
    }
    next(error);
  }
}

/**
 * List pg-boss queue entries whose SubmissionJob row is gone.
 * GET /api/admin/jobs/orphaned-queue
 */
async function listOrphanedQueueEntries(req, res, next) {
  try {
    const entries = await jobAdminService.findOrphanedQueueEntries();
    res.json({ entries, total: entries.length });
  } catch (error) {
    next(error);
  }
}

/**
 * Cancel every orphaned queue entry.
 * POST /api/admin/jobs/purge-orphaned-queue
 */
async function purgeOrphanedQueueEntries(req, res, next) {
  try {
    const result = await jobAdminService.purgeOrphanedQueueEntries();
    logger.info('Orphaned queue purge by admin', { cancelled: result.cancelled, userId: req.userId });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Cancel a job but keep its record.
 * POST /api/admin/jobs/:id/cancel
 */
async function cancelJob(req, res, next) {
  try {
    const job = await jobAdminService.cancelJobById(req.params.id);
    if (!job) throw new ValidationError('No such job.');
    res.json({ id: job.id, status: job.status });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listJobs,
  getMeta,
  deleteJob,
  bulkDelete,
  cleanupStale,
  listOrphanedQueueEntries,
  purgeOrphanedQueueEntries,
  cancelJob
};
