/**
 * App Config Routes
 */

const express = require('express');
const appConfigController = require('../controllers/app-config.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

// All routes require authentication and admin role
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));

// GET /api/app-config - List all configs
router.get('/', appConfigController.list);

// GET /api/app-config/:key - Get config by key
router.get('/:key', appConfigController.getByKey);

// PUT /api/app-config - Create or update config
router.put('/', validateBody('appConfigUpsert'), appConfigController.upsert);

// DELETE /api/app-config/:key - Delete config
router.delete('/:key', appConfigController.delete);

module.exports = router;
