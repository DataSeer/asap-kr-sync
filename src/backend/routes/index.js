/**
 * API Routes Aggregator
 */

const express = require('express');
const authRoutes = require('./auth.routes');
const usersRoutes = require('./users.routes');
const teamsRoutes = require('./teams.routes');
const submissionsRoutes = require('./submissions.routes');
const configRoutes = require('./config.routes');
const profileRoutes = require('./profile.routes');
const resourceTypesRoutes = require('./resource-types.routes');
const appConfigRoutes = require('./app-config.routes');
const enrichmentListRoutes = require('./enrichment-list.routes');
const demosRoutes = require('./demos.routes');
const krtRoutes = require('./krt.routes');

const router = express.Router();

// Mount routes
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/teams', teamsRoutes);
router.use('/submissions', submissionsRoutes);
router.use('/config', configRoutes);
router.use('/profile', profileRoutes);
router.use('/resource-types', resourceTypesRoutes);
router.use('/app-config', appConfigRoutes);
router.use('/enrichment-list', enrichmentListRoutes);
router.use('/demos', demosRoutes);
router.use('/krt', krtRoutes);

// API info endpoint
router.get('/', (req, res) => {
  res.json({
    name: 'KRT Assist API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      users: '/api/users',
      teams: '/api/teams',
      submissions: '/api/submissions'
    }
  });
});

module.exports = router;
