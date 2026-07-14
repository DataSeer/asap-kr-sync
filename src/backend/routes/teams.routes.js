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

// GET /api/teams/export - Download all teams as CSV (admin and ds_annotator)
router.get('/export',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  teamsController.exportCsv
);

// POST /api/teams/import - Upsert teams from parsed CSV rows (admin and ds_annotator)
router.post('/import',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  validateBody('teamsImport'),
  teamsController.importCsv
);

// GET /api/teams - List teams (admin and ds_annotator only)
router.get('/',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR),
  teamsController.list
);

// Email-mapping roster routes — declared before /:id so the literal
// "email-mappings" segment is never captured as a team id.

// GET /api/teams/email-mappings/export - Download the full roster as CSV
router.get('/email-mappings/export',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR, ROLES.ASAP_PM),
  teamsController.exportEmailMappings
);

// GET /api/teams/email-mappings - List (team, email) mappings (admin and ds_annotator only)
router.get('/email-mappings',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR, ROLES.ASAP_PM),
  teamsController.listEmailMappings
);

// POST /api/teams/email-mappings - Bulk-create mappings (admin, ds_annotator, asap_pm)
router.post('/email-mappings',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR, ROLES.ASAP_PM),
  validateBody('createTeamEmailMappings'),
  teamsController.createEmailMappings
);

// DELETE /api/teams/email-mappings/:id - Delete a mapping (admin, ds_annotator, asap_pm)
router.delete('/email-mappings/:id',
  requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR, ROLES.ASAP_PM),
  teamsController.deleteEmailMapping
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
