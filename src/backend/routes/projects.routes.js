/**
 * Project Routes
 */

const express = require('express');
const projectsController = require('../controllers/projects.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/projects/codes - Active project codes (all authenticated users)
router.get('/codes', projectsController.getCodes);

// GET /api/projects/export - Download all projects as CSV (admin and ds_annotator)
router.get('/export',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  projectsController.exportCsv
);

// POST /api/projects/import - Upsert projects from parsed CSV rows (admin and ds_annotator)
router.post('/import',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('projectsImport'),
  projectsController.importCsv
);

// GET /api/projects - List projects (admin and ds_annotator only)
router.get('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  projectsController.list
);

// POST /api/projects - Create project (admin and ds_annotator only)
router.post('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('createProject'),
  projectsController.create
);

// PATCH /api/projects/:code - Update project (admin and ds_annotator only)
router.patch('/:code',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('updateProject'),
  projectsController.update
);

// DELETE /api/projects/:code - Delete project (admin and ds_annotator only)
router.delete('/:code',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  projectsController.delete
);

module.exports = router;
