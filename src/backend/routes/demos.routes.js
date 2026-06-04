/**
 * Demos Routes
 *
 * Lists demo manuscripts available on disk for the "Load Demo" selectors in
 * PDFView and KRTView. Discovery is purely filesystem-driven — drop new files
 * into src/frontend/public/demo-files/ and they'll appear after a restart.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { requireAdmin } = require('../middleware/role.middleware');
const demoDataService = require('../services/demo-data.service');

const router = express.Router();

router.use(authenticate);

// GET /api/demos - List discovered demos { demos: [...] }
// Admin-only: demo discovery is an admin convenience (the "Use Demo Data"
// selector on Create and the Edit-Metadata demo lookup are both admin-only).
router.get('/', requireAdmin, (req, res) => {
  const demos = demoDataService.listAvailableDemos();
  res.json({ demos });
});

module.exports = router;
