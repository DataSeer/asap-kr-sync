/**
 * User Routes
 */

const express = require('express');
const usersController = require('../controllers/users.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole, requireAdmin } = require('../middleware/role.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/users - List users (admin, ds_annotator see all; asap_pm sees their teams only)
router.get('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR, ROLES.ASAP_PM),
  usersController.list
);

// GET /api/users/:id - Get user by ID (admin, ds_annotator, asap_pm)
router.get('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR, ROLES.ASAP_PM),
  usersController.getById
);

// POST /api/users - Create user (admin and ds_annotator only)
router.post('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('createUser'),
  usersController.create
);

// PATCH /api/users/:id - Update user (admin and ds_annotator only)
router.patch('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('updateUser'),
  usersController.update
);

// DELETE /api/users/:id - Delete user (admin only)
router.delete('/:id',
  requireAdmin,
  usersController.delete
);

module.exports = router;
