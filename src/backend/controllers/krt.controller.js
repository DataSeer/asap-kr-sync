/**
 * KRT Controller
 */

const krtService = require('../services/krt/krt.service');
const parserService = require('../services/krt/parser.service');
const validatorService = require('../services/krt/validator.service');
const { KRTData, ValidationResult, ChangeLog, Submission, sequelize } = require('../models');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { statusToStep } = require('../utils/helpers');
const logger = require('../utils/logger');

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
        suggestion: error.suggestion
      });
    });

    res.json({
      rows: krtData.map(row => row.toKRTRow()),
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
    const { column, value, source } = req.body;

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
      'additional_information': 'additionalInformation'
    };

    const field = columnMap[column] || column;
    const oldValue = krtRow[field];
    krtRow[field] = value;
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
  validate,
  download
};
