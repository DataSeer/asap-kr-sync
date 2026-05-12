/**
 * Demos Routes
 *
 * Lists demo manuscripts available on disk for the "Load Demo" selectors in
 * PDFView and KRTView. Discovery is purely filesystem-driven — drop new files
 * into src/frontend/public/demo-files/ and they'll appear after a restart.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const demoDataService = require('../services/demo-data.service');

const router = express.Router();

router.use(authenticate);

// GET /api/demos - List discovered demos { demos: [...] }
router.get('/', (req, res) => {
  const demos = demoDataService.listAvailableDemos();
  res.json({ demos });
});

module.exports = router;
