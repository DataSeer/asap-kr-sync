/**
 * Main KRT Service
 * Coordinates KRT operations
 */

const Papa = require('papaparse');
const ExcelJS = require('exceljs');
const { sequelize, KRTData, File, ChangeLog, ValidationResult, Submission } = require('../../models');
const parserService = require('./parser.service');
const validatorService = require('./validator.service');
const s3Service = require('../storage/s3.service');
const { generateS3Key } = require('../../utils/helpers');
const { KRT_COLUMNS, FILE_TYPES, getResourceTypeGroupOrder } = require('../../config/constants');
const logger = require('../../utils/logger');

/**
 * Upload and process KRT file
 * @param {string} submissionId
 * @param {object} file - Multer file object
 * @param {string} userId
 * @returns {Promise<object>} Processing result
 */
async function uploadAndProcess(submissionId, file, userId, round = 1) {
  // Parse the file
  const rows = await parserService.parseFile(
    file.buffer,
    file.mimetype,
    file.originalname
  );

  // Validate columns
  const columnValidation = parserService.validateColumns(rows);
  if (!columnValidation.valid) {
    logger.warn('KRT file missing columns', {
      submissionId,
      missingColumns: columnValidation.missingColumns
    });
  }

  // Get submission for manuscriptId (read-only — outside the transaction)
  const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'manuscriptId', 'currentRound'] });

  // Get version number (read-only — outside the transaction).
  // `version` is per-(submission, type, round): each round restarts at 1.
  const currentVersion = await File.getLatestVersion(submissionId, FILE_TYPES.KRT, round);
  const newVersion = currentVersion + 1;

  // Upload to S3 (S3 is not transactional). If the DB writes below fail, this
  // object becomes orphaned but harmless: a re-upload generates a new version
  // with a new S3 key, and S3 lifecycle rules can clean up unreferenced keys.
  const s3Key = generateS3Key(submission.manuscriptId, submissionId, round, FILE_TYPES.KRT, file.originalname, newVersion);
  await s3Service.uploadFile(s3Key, file.buffer, file.mimetype);

  // Atomically: insert File record, clear stale KRTData for this round,
  // bulk-insert new rows, and write the audit-log entry. If any step fails,
  // the DB rolls back leaving no partial state (e.g. KRT rows without an
  // accompanying ChangeLog entry).
  const fileRecord = await sequelize.transaction(async (t) => {
    const fr = await File.create({
      submissionId,
      type: FILE_TYPES.KRT,
      fileName: file.originalname,
      s3Key,
      mimeType: file.mimetype,
      size: file.size,
      version: newVersion,
      round
    }, { transaction: t });

    // ValidationResult rows are re-built by validateSubmission below, so we
    // don't need to clear them here — clearing inside the transaction would
    // duplicate work and force validateSubmission to read its own writes.
    await KRTData.destroy({ where: { submissionId, round }, transaction: t });

    await KRTData.bulkCreate(
      rows.map(row => ({
        submissionId,
        resourceType: row['RESOURCE TYPE'],
        resourceName: row['RESOURCE NAME'],
        source: row['SOURCE'],
        identifier: row['IDENTIFIER'],
        newReuse: row['NEW/REUSE'],
        additionalInformation: row['ADDITIONAL INFORMATION'],
        round
      })),
      { transaction: t }
    );

    await ChangeLog.create({
      submissionId,
      userId,
      action: 'upload',
      step: 1,
      round,
      description: `Uploaded KRT file: ${file.originalname} (v${newVersion})`
    }, { transaction: t });

    return fr;
  });

  // Validation runs after the upload commits — it produces annotation rows
  // (ValidationResult) that are diagnostic, not load-bearing for the upload's
  // success. Failure here leaves the upload intact; a manual re-validate
  // recovers the annotations.
  const validationResult = await validatorService.validateSubmission(submissionId, round);

  return {
    fileId: fileRecord.id,
    version: newVersion,
    rowCount: rows.length,
    validation: validationResult
  };
}

/**
 * Validate all KRT data for a submission
 * @param {string} submissionId
 * @returns {Promise<object>} Validation result
 */
async function validateSubmission(submissionId, round) {
  return validatorService.validateSubmission(submissionId, round);
}

/**
 * Generate downloadable KRT file
 * @param {string} submissionId
 * @param {string} format - 'csv' or 'xlsx'
 * @returns {Promise<object>} { buffer, filename, mimeType }
 */
async function generateDownload(submissionId, format = 'csv', round) {
  // Get KRT data
  const where = { submissionId };
  if (round !== undefined) {
    where.round = round;
  }
  const rows = await KRTData.findAll({
    where,
    order: [['createdAt', 'ASC']]
  });

  // Sort rows by resource type group order, then by resource name A-Z
  const groupOrder = await getResourceTypeGroupOrder();
  rows.sort((a, b) => {
    const groupA = groupOrder[a.resourceType] ?? 99;
    const groupB = groupOrder[b.resourceType] ?? 99;
    if (groupA !== groupB) return groupA - groupB;
    return (a.resourceName || '').localeCompare(b.resourceName || '');
  });

  // Convert to plain objects (use ?? to preserve empty strings)
  const data = rows.map(row => ({
    'RESOURCE TYPE': row.resourceType ?? '',
    'RESOURCE NAME': row.resourceName ?? '',
    'SOURCE': row.source ?? '',
    'IDENTIFIER': row.identifier ?? '',
    'NEW/REUSE': row.newReuse ?? '',
    'ADDITIONAL INFORMATION': row.additionalInformation ?? ''
  }));

  if (format === 'xlsx') {
    return generateExcel(data, submissionId);
  }

  return generateCSV(data, submissionId);
}

/**
 * Generate CSV file
 */
function generateCSV(data, submissionId) {
  const csv = Papa.unparse(data, {
    columns: KRT_COLUMNS,
    header: true
  });

  return {
    buffer: Buffer.from(csv, 'utf-8'),
    filename: `krt_${submissionId}.csv`,
    mimeType: 'text/csv'
  };
}

/**
 * Generate Excel file with one "KRT" sheet, header row from KRT_COLUMNS,
 * data rows in the same column order. Async because exceljs streams to a
 * buffer asynchronously.
 */
async function generateExcel(data, submissionId) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('KRT');

  sheet.columns = KRT_COLUMNS.map(col => ({ header: col, key: col }));
  for (const row of data) {
    sheet.addRow(row);
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return {
    buffer: Buffer.from(buffer),
    filename: `krt_${submissionId}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

/**
 * Get KRT data with validation errors
 * @param {string} submissionId
 * @returns {Promise<object>}
 */
async function getKRTWithErrors(submissionId, round) {
  const where = { submissionId };
  if (round !== undefined) {
    where.round = round;
  }
  const krtData = await KRTData.findAll({
    where,
    order: [['createdAt', 'ASC']]
  });

  const vrWhere = { submissionId };
  if (round !== undefined) {
    vrWhere.round = round;
  }
  const validationResults = await ValidationResult.findAll({
    where: vrWhere
  });

  // Group errors by row ID
  const errorsByRow = {};
  validationResults.forEach(error => {
    if (!errorsByRow[error.rowId]) {
      errorsByRow[error.rowId] = {};
    }
    if (!errorsByRow[error.rowId][error.columnName]) {
      errorsByRow[error.rowId][error.columnName] = [];
    }
    errorsByRow[error.rowId][error.columnName].push({
      type: error.errorType,
      message: error.errorMessage,
      severity: error.severity,
      suggestion: error.suggestion
    });
  });

  return {
    rows: krtData.map(row => ({
      ...row.toKRTRow(),
      errors: errorsByRow[row.id] || {}
    })),
    summary: {
      totalRows: krtData.length,
      errorCount: validationResults.filter(e => e.severity === 'error').length,
      warningCount: validationResults.filter(e => e.severity === 'warning').length
    }
  };
}

module.exports = {
  uploadAndProcess,
  validateSubmission,
  generateDownload,
  getKRTWithErrors
};
