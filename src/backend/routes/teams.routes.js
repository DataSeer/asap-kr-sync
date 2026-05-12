/**
 * Team Routes
 */

const express = require('express');
const teamsController = require('../controllers/teams.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/teams/codes - Get active team codes (all authenticated users)
router.get('/codes', teamsController.getCodes);

// GET /api/teams - List teams (admin and ds_annotator only)
router.get('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  teamsController.list
);

// GET /api/teams/:id - Get team by ID (admin and ds_annotator only)
router.get('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  teamsController.getById
);

// POST /api/teams - Create team (admin and ds_annotator only)
router.post('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('createTeam'),
  teamsController.create
);

// PATCH /api/teams/:id - Update team (admin and ds_annotator only)
router.patch('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('updateTeam'),
  teamsController.update
);

// DELETE /api/teams/:id - Delete team (admin and ds_annotator only)
router.delete('/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  teamsController.delete
);

module.exports = router;
