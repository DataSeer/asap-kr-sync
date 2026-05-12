/**
 * Profile Routes
 */

const express = require('express');
const profileController = require('../controllers/profile.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validateBody } = require('../middleware/validation.middleware');

const router = express.Router();

// All profile routes require authentication
router.use(authenticate);

/**
 * GET /api/profile
 * Get current user's profile
 */
router.get('/', profileController.getProfile);

/**
 * PATCH /api/profile
 * Update current user's profile (name, password)
 */
router.patch('/', validateBody('updateProfile'), profileController.updateProfile);

module.exports = router;
