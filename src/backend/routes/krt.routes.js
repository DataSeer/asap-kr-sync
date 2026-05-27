/**
 * Stateless KRT Routes
 *
 * Endpoints that operate on a KRT file without needing a submission record.
 * Used by the submission-create form to pre-flight a file's format before
 * committing to creating the submission — if the headers aren't on row 1,
 * we'd otherwise leave an orphan submission behind and surface a confusing
 * "0 rows" state to the user.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { uploadKRT, handleMulterError } = require('../middleware/upload.middleware');
const { uploadLimiter } = require('../middleware/rate-limit.middleware');
const parserService = require('../services/krt/parser.service');
const { KRT_COLUMNS } = require('../config/constants');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();

router.use(authenticate);

/**
 * POST /api/krt/validate-format
 *
 * Parse the uploaded file and verify the required header columns are present.
 * Stateless — no DB writes, no S3 uploads. Returns:
 *
 *   200 { valid: true }
 *   400 { valid: false, error: '...', missingColumns: [...] }
 */
router.post(
  '/validate-format',
  uploadLimiter,
  uploadKRT.single('file'),
  handleMulterError,
  async (req, res, next) => {
    try {
      if (!req.file) throw new ValidationError('No file uploaded');

      let rows;
      try {
        rows = await parserService.parseFile(
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname
        );
      } catch (err) {
        // Parser-level failures (bad CSV / Excel) — surface to the client.
        logger.warn('KRT format validation: parser error', {
          fileName: req.file.originalname,
          error: err.message
        });
        return res.status(400).json({
          valid: false,
          error: err.message,
          missingColumns: KRT_COLUMNS
        });
      }

      const columnValidation = parserService.validateColumns(rows);
      if (!columnValidation.valid) {
        return res.status(400).json({
          valid: false,
          error:
            `This file doesn't look like a Key Resources Table. ` +
            `Make sure the first row contains the column headers: ${KRT_COLUMNS.join(', ')}.`,
          missingColumns: columnValidation.missingColumns
        });
      }

      return res.json({ valid: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
