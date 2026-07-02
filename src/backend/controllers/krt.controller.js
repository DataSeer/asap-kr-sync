/**
 * KRT Controller
 */

const krtService = require('../services/krt/krt.service');
const parserService = require('../services/krt/parser.service');
const validatorService = require('../services/krt/validator.service');
const { KRTData, ValidationResult, ChangeLog, Submission, sequelize } = require('../models');
const { NotFoundError, ValidationError, AuthorizationError } = require('../utils/errors');
const { statusToStep } = require('../utils/helpers');
const { ROLES } = require('../config/constants');
const logger = require('../utils/logger');

// Roles allowed to see/edit the QC and Optional flags (request G1). Regular
// ASAP users (author / asap_pm) never see or set them.
const QC_OPTIONAL_ROLES = [ROLES.ADMIN, ROLES.DS_ANNOTATOR];
const QC_OPTIONAL_FIELDS = new Set(['isQc', 'isOptional']);

/**
 * Upload KRT file
 * POST /api/submissions/:id/krt/upload
 */
async function upload(req, res, next) {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    // Reject HTML/XML bodies masquerading as CSV/XLSX. Happens when the
    // frontend fetches a missing demo file and a fallback returns index.html,
    // then uploads the response body as the user's KRT.
    const head = req.file.buffer.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
      throw new ValidationError('Uploaded file appears to be HTML, not a CSV or spreadsheet');
    }

    const submission = req.submission;
    const result = await krtService.uploadAndProcess(
      submission.id,
      req.file,
      req.userId,
      submission.currentRound
    );

    // Set status to step_krt if this is the first upload (from draft)
    if (submission.status === 'draft') {
      submission.status = 'step_krt';
      await submission.save();
    }

    logger.info('KRT uploaded', { submissionId: submission.id, rowCount: result.rowCount, status: submission.status });

    res.json({
      message: 'KRT uploaded successfully',
      ...result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get KRT data
 * GET /api/submissions/:id/krt
 */
async function getData(req, res, next) {
  try {
    const round = req.submission.currentRound;
    const krtData = await KRTData.findAll({
      where: { submissionId: req.params.id, round },
      order: [['createdAt', 'ASC']]
    });

    const validationResults = await ValidationResult.findAll({
      where: { submissionId: req.params.id, round }
    });

    // Provenance for the "added by tool" badge: a row was inserted by the
    // pipeline (an accepted AI add_row suggestion) iff it has an add_row
    // change-log entry sourced from 'ai_suggestion'. Manual "Add Row" writes
    // the same action with source 'manual', so the two are distinguishable
    // without any extra column on krt_data.
    const toolAddLogs = await ChangeLog.findAll({
      where: { submissionId: req.params.id, round, action: 'add_row', source: 'ai_suggestion' },
      attributes: ['rowId']
    });
    const toolAddedRowIds = new Set(toolAddLogs.map(log => log.rowId).filter(Boolean));

    // Group validation errors by row ID
    const errorsByRow = {};
    validationResults.forEach(error => {
      if (!errorsByRow[error.rowId]) {
        errorsByRow[error.rowId] = [];
      }
      errorsByRow[error.rowId].push({
        column: error.columnName,
        type: error.errorType,
        message: error.errorMessage,
        severity: error.severity,
        suggestion: error.suggestion,
        // Machine-actionable fix (request E): the frontend offers one-click /
        // bulk apply when a concrete canonical target is present.
        suggestedValue: error.suggestedValue || null,
        autoFixable: !!error.suggestedValue
      });
    });

    res.json({
      rows: krtData.map(row => ({
        ...row.toKRTRow(),
        addedByTool: toolAddedRowIds.has(row.id)
      })),
      validationErrors: errorsByRow,
      totalErrors: validationResults.filter(e => e.severity === 'error').length,
      totalWarnings: validationResults.filter(e => e.severity === 'warning').length
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update KRT row
 * PATCH /api/submissions/:id/krt/:rowId
 */
async function updateRow(req, res, next) {
  try {
    const { rowId } = req.params;
    const { column, value, source } = req.validatedBody;

    const round = req.submission.currentRound;
    const krtRow = await KRTData.findOne({
      where: {
        id: rowId,
        submissionId: req.params.id,
        round
      }
    });

    if (!krtRow) {
      throw new NotFoundError('KRT row');
    }

    // Map column name to model field
    const columnMap = {
      'resource_type': 'resourceType',
      'resource_name': 'resourceName',
      'source': 'source',
      'identifier': 'identifier',
      'new_reuse': 'newReuse',
      'additional_information': 'additionalInformation',
      'is_qc': 'isQc',
      'is_optional': 'isOptional'
    };

    // Strict allowlist: never fall back to the raw client string — that would
    // allow writes to arbitrary model attributes (submissionId, round, id, ...).
    // The route schema already restricts `column`; this guards against drift.
    const field = columnMap[column];
    if (!field) {
      throw new ValidationError(`Unknown KRT column: ${column}`);
    }

    // QC / Optional flags are role-gated (request G1) and boolean-typed.
    let nextValue = value;
    if (QC_OPTIONAL_FIELDS.has(field)) {
      if (!QC_OPTIONAL_ROLES.includes(req.user?.role)) {
        throw new AuthorizationError('Only administrators and DS annotators can set QC/Optional flags');
      }
      nextValue = value === true || value === 'true' || value === 1 || value === '1';
    }

    const oldValue = krtRow[field];
    krtRow[field] = nextValue;
    await krtRow.save();

    // Log the change with source (defaults to 'manual' if not provided)
    await ChangeLog.create({
      submissionId: req.params.id,
      userId: req.userId,
      action: 'edit',
      source: source || 'manual',
      step: statusToStep(req.submission.status),
      round,
      rowId: krtRow.id,
      columnName: column,
      oldValue,
      newValue: value
    });

    // Re-validate the row
    await validatorService.validateRow(krtRow, req.params.id, true, null, round);

    logger.info('KRT row updated', {
      submissionId: req.params.id,
      rowId,
      column,
      userId: req.userId
    });

    res.json({ row: krtRow.toKRTRow() });
  } catch (error) {
    next(error);
  }
}

/**
 * Add KRT row
 * POST /api/submissions/:id/krt/row
 */
async function addRow(req, res, next) {
  try {
    const rowData = req.validatedBody;
    const { changeSource } = req.body; // Source for change log (separate from KRT source field)
    const round = req.submission.currentRound;

    const newRow = await KRTData.create({
      submissionId: req.params.id,
      resourceType: rowData.resourceType,
      resourceName: rowData.resourceName,
      source: rowData.source,
      identifier: rowData.identifier,
      newReuse: rowData.newReuse,
      additionalInformation: rowData.additionalInformation,
      round
    });

    // Log the change with source (defaults to 'manual' if not provided)
    await ChangeLog.create({
      submissionId: req.params.id,
      userId: req.userId,
      action: 'add_row',
      source: changeSource || 'manual',
      step: statusToStep(req.submission.status),
      round,
      rowId: newRow.id,
      description: 'New row added'
    });

    // Validate the new row (non-critical, can fail independently)
    await validatorService.validateRow(newRow, req.params.id, true, null, round);

    logger.info('KRT row added', {
      submissionId: req.params.id,
      rowId: newRow.id,
      userId: req.userId
    });

    res.status(201).json({ row: newRow.toKRTRow() });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete KRT row
 * DELETE /api/submissions/:id/krt/:rowId
 */
async function deleteRow(req, res, next) {
  try {
    const { rowId } = req.params;
    const { source } = req.body; // Source for change log
    const round = req.submission.currentRound;

    const krtRow = await KRTData.findOne({
      where: {
        id: rowId,
        submissionId: req.params.id,
        round
      }
    });

    if (!krtRow) {
      throw new NotFoundError('KRT row');
    }

    // Log the deletion before removing (with source)
    await ChangeLog.create({
      submissionId: req.params.id,
      userId: req.userId,
      action: 'delete_row',
      source: source || 'manual',
      step: statusToStep(req.submission.status),
      round,
      rowId: krtRow.id,
      description: `Deleted row: ${krtRow.resourceName}`,
      metadata: {
        resourceType: krtRow.resourceType,
        resourceName: krtRow.resourceName,
        source: krtRow.source,
        identifier: krtRow.identifier,
        newReuse: krtRow.newReuse,
        additionalInformation: krtRow.additionalInformation
      }
    });

    // Clear validation results for this row
    await ValidationResult.destroy({
      where: {
        submissionId: req.params.id,
        rowId: krtRow.id
      }
    });

    await krtRow.destroy();

    logger.info('KRT row deleted', {
      submissionId: req.params.id,
      rowId,
      userId: req.userId
    });

    res.json({ message: 'Row deleted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Merge several KRT rows into one (request G2).
 * POST /api/submissions/:id/krt/merge
 * Body: { rowIds: string[], merged: { resourceType, resourceName, source,
 *         identifier, newReuse, additionalInformation, isQc?, isOptional? } }
 *
 * Transactional: creates the merged row and deletes the originals together so
 * the table never ends up with a duplicate or a gap on partial failure.
 */
async function mergeRows(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const submissionId = req.params.id;
    const round = req.submission.currentRound;
    const { rowIds, merged } = req.body;

    if (!Array.isArray(rowIds) || rowIds.length < 2) {
      throw new ValidationError('Select at least two rows to merge');
    }
    if (!merged || typeof merged !== 'object') {
      throw new ValidationError('Merged row values are required');
    }

    // Only operate on rows that genuinely belong to this submission/round.
    const originals = await KRTData.findAll({
      where: { id: rowIds, submissionId, round },
      transaction: t
    });
    if (originals.length < 2) {
      throw new ValidationError('Some selected rows could not be found for this submission');
    }

    // QC/Optional are role-gated (same rule as updateRow): ignore them unless
    // the caller is an Administrator or DS Annotator.
    const privileged = QC_OPTIONAL_ROLES.includes(req.user?.role);
    const newRow = await KRTData.create({
      submissionId,
      round,
      resourceType: merged.resourceType ?? null,
      resourceName: merged.resourceName ?? null,
      source: merged.source ?? null,
      identifier: merged.identifier ?? null,
      newReuse: merged.newReuse ?? null,
      additionalInformation: merged.additionalInformation ?? null,
      isQc: privileged ? !!merged.isQc : false,
      isOptional: privileged ? !!merged.isOptional : false
    }, { transaction: t });

    const step = statusToStep(req.submission.status);
    await ChangeLog.create({
      submissionId, userId: req.userId, action: 'add_row', source: 'manual', step, round,
      rowId: newRow.id, description: `Merged ${originals.length} rows into one`
    }, { transaction: t });

    const originalIds = originals.map(r => r.id);
    await ValidationResult.destroy({ where: { submissionId, rowId: originalIds }, transaction: t });
    for (const row of originals) {
      await ChangeLog.create({
        submissionId, userId: req.userId, action: 'delete_row', source: 'manual', step, round,
        rowId: row.id, description: `Merged into ${newRow.id}: ${row.resourceName || ''}`
      }, { transaction: t });
    }
    await KRTData.destroy({ where: { id: originalIds, submissionId, round }, transaction: t });

    await t.commit();

    // Validate the new row after commit (non-critical).
    await validatorService.validateRow(newRow, submissionId, true, null, round);

    logger.info('KRT rows merged', { submissionId, mergedCount: originals.length, newRowId: newRow.id, userId: req.userId });
    res.status(201).json({ row: newRow.toKRTRow() });
  } catch (error) {
    await t.rollback();
    next(error);
  }
}

/**
 * Re-validate KRT
 * POST /api/submissions/:id/krt/validate
 */
async function validate(req, res, next) {
  try {
    const result = await krtService.validateSubmission(req.params.id, req.submission.currentRound);

    // Status is now step-based and only changes on navigation
    // Validation errors are tracked separately in ValidationResult table

    logger.info('KRT validated', {
      submissionId: req.params.id,
      errorCount: result.errorCount
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * Download corrected KRT
 * GET /api/submissions/:id/krt/download
 */
async function download(req, res, next) {
  try {
    const format = req.query.format || 'csv';
    const round = req.query.round ? parseInt(req.query.round, 10) : req.submission.currentRound;
    const result = await krtService.generateDownload(req.params.id, format, round);

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.buffer);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  upload,
  getData,
  updateRow,
  addRow,
  deleteRow,
  mergeRows,
  validate,
  download
};
