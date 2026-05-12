/**
 * Resource Types Routes
 */

const express = require('express');
const resourceTypesController = require('../controllers/resource-types.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/resource-types/names - Get active resource type names (all authenticated users)
router.get('/names', resourceTypesController.getNames);

// GET /api/resource-types - List resource types (admin and ds_annotator only)
router.get('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.list
);

// GET /api/resource-types/export - Export resource types as CSV (admin and ds_annotator only)
router.get('/export',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.exportCsv
);

// POST /api/resource-types/import - Bulk import resource types (admin and ds_annotator only)
router.post('/import',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.importEntries
);

// GET /api/resource-types/:id - Get resource type by ID (admin and ds_annotator only)
router.get('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.getById
);

// POST /api/resource-types - Create resource type (admin and ds_annotator only)
router.post('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.create
);

// PATCH /api/resource-types/:id - Update resource type (admin and ds_annotator only)
router.patch('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.update
);

// DELETE /api/resource-types/:id - Delete resource type (admin and ds_annotator only)
router.delete('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  resourceTypesController.delete
);

module.exports = router;
