/**
 * Enrichment List Routes
 *
 * All routes are scoped under /:category where category must be one of:
 * 'software', 'materials', 'datasets', 'protocols'
 *
 * Replaces the 4 separate list route files.
 */

const express = require('express');
const enrichmentListController = require('../controllers/enrichment-list.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { ROLES } = require('../config/constants');

const router = express.Router();

const VALID_CATEGORIES = ['software', 'materials', 'datasets', 'protocols'];

// All routes require authentication + admin or ds_annotator role
router.use(authenticate);
router.use(requireRole(ROLES.ADMIN, ROLES.DS_ANNOTATOR));

/**
 * Category validation middleware — rejects unknown categories with 400.
 * Applied to all routes under /:category.
 */
function validateCategory(req, res, next) {
  const { category } = req.params;
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      error: `Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`
    });
  }
  next();
}

// Unified routes — declared BEFORE the `:category` matcher so the literal
// paths win route resolution.
//
// GET /api/enrichment-list                 — cross-category list (?category= filter optional)
// GET /api/enrichment-list/_counts         — per-category counts in one call
router.get('/', enrichmentListController.listAll);
router.get('/_counts', enrichmentListController.getAllCounts);

// GET /api/enrichment-list/:category - List entries with optional search and type filter
router.get('/:category', validateCategory, enrichmentListController.list);

// GET /api/enrichment-list/:category/counts - Get entry counts per resource type
router.get('/:category/counts', validateCategory, enrichmentListController.getCounts);

// GET /api/enrichment-list/:category/export - Export entries as CSV (optional ?resourceType= filter)
router.get('/:category/export', validateCategory, enrichmentListController.exportCsv);

// POST /api/enrichment-list/:category/import - Bulk import entries from parsed CSV data
router.post('/:category/import', validateCategory, validateBody('enrichmentListImport'), enrichmentListController.importEntries);

// GET /api/enrichment-list/:category/:entryId - Get single entry
router.get('/:category/:entryId', validateCategory, enrichmentListController.getById);

// POST /api/enrichment-list/:category - Create entry
router.post('/:category', validateCategory, validateBody('enrichmentListEntry'), enrichmentListController.create);

// PATCH /api/enrichment-list/:category/:entryId - Update entry
router.patch('/:category/:entryId', validateCategory, validateBody('updateEnrichmentListEntry'), enrichmentListController.update);

// DELETE /api/enrichment-list/:category/:entryId - Delete entry
router.delete('/:category/:entryId', validateCategory, enrichmentListController.remove);

module.exports = router;
