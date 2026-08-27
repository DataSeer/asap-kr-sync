/**
 * Job Administration Routes
 *
 * Cross-submission view of the processing queue plus cleanup actions.
 *
 * Admin-only. These endpoints read and delete jobs belonging to submissions the
 * caller does not own, so they deliberately sit outside the per-submission
 * `canAccessSubmission` model rather than extending it.
 */

const express = require('express');
const jobAdminController = require('../controllers/job-admin.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));

// GET /api/admin/jobs/meta - filter vocabulary + staleness thresholds
router.get('/meta', jobAdminController.getMeta);

// GET /api/admin/jobs - list jobs with staleness annotations
router.get('/', jobAdminController.listJobs);

// POST /api/admin/jobs/bulk-delete - delete a set of jobs by id
router.post('/bulk-delete', jobAdminController.bulkDelete);

// POST /api/admin/jobs/cleanup - delete everything matching a staleness reason
router.post('/cleanup', jobAdminController.cleanupStale);

// GET /api/admin/jobs/orphaned-queue - queue entries whose job row is gone
router.get('/orphaned-queue', jobAdminController.listOrphanedQueueEntries);

// POST /api/admin/jobs/purge-orphaned-queue - cancel all of them
router.post('/purge-orphaned-queue', jobAdminController.purgeOrphanedQueueEntries);

// POST /api/admin/jobs/:id/cancel - stop a job but keep the record
router.post('/:id/cancel', jobAdminController.cancelJob);

// DELETE /api/admin/jobs/:id - delete one job (?force=true to include a running one)
router.delete('/:id', jobAdminController.deleteJob);

module.exports = router;
