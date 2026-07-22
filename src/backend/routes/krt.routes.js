/**
 * Stateless KRT Routes
 *
 * Endpoints that operate on a KRT file without needing a submission record.
 * Used by the submission-create form to pre-flight a file's format before
 * committing to creating the submission — if the headers aren't on row 1,
 * we'd otherwise leave an orphan submission behind and surface a confusing
 * "0 rows" state to the user.
 */

const crypto = require('crypto');
const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { uploadKRT, handleMulterError } = require('../middleware/upload.middleware');
const { uploadLimiter, apiLimiter } = require('../middleware/rate-limit.middleware');
const parserService = require('../services/krt/parser.service');
const validatorService = require('../services/krt/validator.service');
const krtService = require('../services/krt/krt.service');
const { KRT_COLUMNS } = require('../config/constants');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const router = express.Router();

router.use(authenticate);

// Guard: reject payloads with too many rows before we spend CPU validating or
// building a file. The interactive editor caps out well below this.
const MAX_STATELESS_ROWS = 2000;

/**
 * Coerce a client-supplied rows payload into the shape the validator/export
 * helpers expect: an array of objects keyed by the uppercase KRT columns, each
 * with a stable `id`. Unknown keys are dropped; a missing id is generated.
 */
function normalizeStatelessRows(rows) {
  if (!Array.isArray(rows)) {
    throw new ValidationError('`rows` must be an array');
  }
  if (rows.length > MAX_STATELESS_ROWS) {
    throw new ValidationError(`Too many rows (max ${MAX_STATELESS_ROWS})`);
  }
  return rows.map(row => {
    const clean = { id: (row && typeof row.id === 'string' && row.id) || crypto.randomUUID() };
    for (const col of KRT_COLUMNS) {
      clean[col] = row && row[col] != null ? String(row[col]) : '';
    }
    if (row && typeof row.isOptional === 'boolean') clean.isOptional = row.isOptional;
    return clean;
  });
}

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
            "This file doesn't look like a Key Resources Table. " +
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

/**
 * POST /api/krt/parse
 *
 * Parse an uploaded KRT file and validate it — statelessly. No submission is
 * created, nothing is written to the DB or S3. Backs the standalone validation
 * page. Returns the same shape as GET /api/submissions/:id/krt:
 *
 *   200 { rows, validationErrors, totalErrors, totalWarnings }
 *   400 { valid: false, error, missingColumns }  (unparseable / not a KRT)
 */
router.post(
  '/parse',
  uploadLimiter,
  uploadKRT.single('file'),
  handleMulterError,
  async (req, res, next) => {
    try {
      if (!req.file) throw new ValidationError('No file uploaded');

      let parsed;
      try {
        parsed = await parserService.parseFile(
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname
        );
      } catch (err) {
        logger.warn('KRT stateless parse: parser error', {
          fileName: req.file.originalname,
          error: err.message
        });
        return res.status(400).json({ valid: false, error: err.message, missingColumns: KRT_COLUMNS });
      }

      const columnValidation = parserService.validateColumns(parsed);
      if (!columnValidation.valid) {
        return res.status(400).json({
          valid: false,
          error:
            "This file doesn't look like a Key Resources Table. " +
            `Make sure the first row contains the column headers: ${KRT_COLUMNS.join(', ')}.`,
          missingColumns: columnValidation.missingColumns
        });
      }

      // parseFile drops header/empty rows and preprocesses values but assigns no
      // ids (those are normally DB-generated). Give each row a stable id so the
      // editor can key edits and validation against it.
      const rows = parsed.map(row => ({ id: crypto.randomUUID(), ...row }));
      const validation = await validatorService.validateKrtRows(rows);

      return res.json({ rows, ...validation });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/krt/validate
 *
 * Re-validate an array of edited rows (JSON body) — statelessly. Used after the
 * user edits cells on the standalone validation page.
 *
 *   Body: { rows: [{ id, 'RESOURCE TYPE', ... }] }
 *   200  { rows, validationErrors, totalErrors, totalWarnings }
 */
router.post('/validate', apiLimiter, async (req, res, next) => {
  try {
    const rows = normalizeStatelessRows(req.body?.rows);
    const validation = await validatorService.validateKrtRows(rows);
    return res.json({ rows, ...validation });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/krt/export
 *
 * Generate a downloadable KRT file (CSV/XLSX) from an array of rows — no
 * submission, no persistence. The response is the file itself.
 *
 *   Body: { rows: [...], format?: 'csv'|'xlsx', filename?: 'base-name' }
 */
router.post('/export', apiLimiter, async (req, res, next) => {
  try {
    const rows = normalizeStatelessRows(req.body?.rows);
    const format = req.body?.format === 'xlsx' ? 'xlsx' : 'csv';
    const baseName = typeof req.body?.filename === 'string' ? req.body.filename : 'krt-validated';

    const result = await krtService.exportRows(rows, format, baseName);

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.send(result.buffer);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
