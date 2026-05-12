/**
 * PDF Service
 *
 * Owns PDF/Word upload, supplemental concatenation, DAS extraction, and the
 * KRT-mutation helpers (applyAddRow, applyEdit, applyDeleteRow) consumed by
 * the suggestion approval flow. The PDF-analysis consolidator lives in
 * `src/backend/services/pdf-analysis/pdf-analysis.service.js`.
 */

const { sequelize, File, ChangeLog, KRTData, ValidationResult, Submission, SubmissionJob } = require('../../models');
const s3Service = require('../storage/s3.service');
const dasExtractorClient = require('./pdf-das-extractor-client.service');
const dasExtractorConfig = require('../../config/pdf-das-extractor-api');
const jobQueue = require('../queue/job-queue.service');
const { generateS3Key } = require('../../utils/helpers');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const logger = require('../../utils/logger');
const path = require('path');

/**
 * Convert DOCX buffer to PDF buffer using libreoffice-convert
 * @param {Buffer} docxBuffer
 * @returns {Promise<Buffer>} PDF buffer
 */
async function convertDocxToPdf(docxBuffer) {
  const libre = require('libreoffice-convert');
  const util = require('util');
  const convert = util.promisify(libre.convert);
  const pdfBuffer = await convert(docxBuffer, '.pdf', undefined);
  return pdfBuffer;
}

/**
 * Concatenate two PDF buffers into one using pdf-lib
 * @param {Buffer} mainPdfBuffer
 * @param {Buffer} supplementalPdfBuffer
 * @returns {Promise<Buffer>} Merged PDF buffer
 */
async function concatenatePDFs(mainPdfBuffer, supplementalPdfBuffer) {
  const { PDFDocument } = require('pdf-lib');

  const mergedDoc = await PDFDocument.create();

  const mainDoc = await PDFDocument.load(mainPdfBuffer);
  const mainPages = await mergedDoc.copyPages(mainDoc, mainDoc.getPageIndices());
  for (const page of mainPages) {
    mergedDoc.addPage(page);
  }

  const suppDoc = await PDFDocument.load(supplementalPdfBuffer);
  const suppPages = await mergedDoc.copyPages(suppDoc, suppDoc.getPageIndices());
  for (const page of suppPages) {
    mergedDoc.addPage(page);
  }

  const mergedBytes = await mergedDoc.save();
  return Buffer.from(mergedBytes);
}

/**
 * Upload PDF or DOCX file (DOCX is converted to PDF).
 * Always creates both a `pdf_original` (unmodified main) and `pdf` (working copy) record.
 * If a supplemental PDF exists for this submission/round, the working `pdf` is the
 * concatenation of main + supplemental. Otherwise both records reference the same S3 file.
 *
 * @param {string} submissionId
 * @param {object} file - Multer file object
 * @param {string} userId
 * @param {number} round
 * @returns {Promise<object>} The working `pdf` File record
 */
async function uploadPDF(submissionId, file, userId, round = 1) {
  const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'manuscriptId'] });
  const manuscriptId = submission?.manuscriptId;

  const ext = path.extname(file.originalname).toLowerCase();
  let pdfBuffer = file.buffer;
  let pdfFileName = file.originalname;
  let pdfMimeType = file.mimetype;
  let pdfSize = file.size;

  // If Word document, convert to PDF
  if (ext === '.docx' || ext === '.doc') {
    logger.info('Converting Word to PDF', { submissionId, originalName: file.originalname });

    // Upload original Word file to S3 for archival
    const archiveVersion = await File.getLatestVersion(submissionId, FILE_TYPES.PDF, round) + 1;
    const docS3Key = generateS3Key(manuscriptId, submissionId, round, FILE_TYPES.PDF, file.originalname, archiveVersion);
    await s3Service.uploadFile(docS3Key, file.buffer, file.mimetype);

    // Convert to PDF
    pdfBuffer = await convertDocxToPdf(file.buffer);
    pdfFileName = file.originalname.replace(/\.docx?$/i, '.pdf');
    pdfMimeType = 'application/pdf';
    pdfSize = pdfBuffer.length;

    logger.info('Word converted to PDF', { submissionId, pdfSize });
  }

  // --- Read latest versions + upload all S3 objects FIRST. DB writes are
  // batched into a single transaction at the end so they're atomic: either
  // both File rows + the audit-log ChangeLog land together or none of them
  // do. Orphan S3 objects on rollback are tolerable; partial DB state is
  // not (audit log would silently drift from data).
  const origVersion = await File.getLatestVersion(submissionId, FILE_TYPES.PDF_ORIGINAL, round) + 1;
  const origS3Key = generateS3Key(manuscriptId, submissionId, round, FILE_TYPES.PDF_ORIGINAL, pdfFileName, origVersion);
  await s3Service.uploadFile(origS3Key, pdfBuffer, pdfMimeType);

  // --- Check for supplemental PDF and concatenate if present ---
  let workingBuffer = pdfBuffer;
  let workingSize = pdfSize;
  let concatenated = false;

  const supplementalPdf = await File.findOne({
    where: { submissionId, type: FILE_TYPES.SUPPLEMENTAL_PDF, round },
    order: [['version', 'DESC']]
  });

  if (supplementalPdf) {
    logger.info('Concatenating main PDF with supplemental', { submissionId });
    const suppBuffer = await s3Service.downloadFile(supplementalPdf.s3Key);
    workingBuffer = await concatenatePDFs(pdfBuffer, suppBuffer);
    workingSize = workingBuffer.length;
    concatenated = true;
    logger.info('PDF concatenation complete', { submissionId, mainSize: pdfSize, supplementalSize: suppBuffer.length, mergedSize: workingSize });
  }

  // --- Store the working PDF (concatenated or same as original) ---
  const pdfVersion = await File.getLatestVersion(submissionId, FILE_TYPES.PDF, round) + 1;
  const pdfS3Key = generateS3Key(manuscriptId, submissionId, round, FILE_TYPES.PDF, pdfFileName, pdfVersion);
  await s3Service.uploadFile(pdfS3Key, workingBuffer, pdfMimeType);

  // Log the upload
  const isWord = ext === '.docx' || ext === '.doc';
  let description = isWord
    ? `Uploaded Word file (converted to PDF): ${file.originalname}`
    : `Uploaded PDF file: ${file.originalname}`;
  if (concatenated) {
    description += ' (concatenated with supplemental methods file)';
  }

  // Atomic DB write: PDF_ORIGINAL + PDF + audit log together.
  const fileRecord = await sequelize.transaction(async (t) => {
    await File.create({
      submissionId,
      type: FILE_TYPES.PDF_ORIGINAL,
      fileName: pdfFileName,
      s3Key: origS3Key,
      mimeType: pdfMimeType,
      size: pdfSize,
      version: origVersion,
      round
    }, { transaction: t });

    const fr = await File.create({
      submissionId,
      type: FILE_TYPES.PDF,
      fileName: pdfFileName,
      s3Key: pdfS3Key,
      mimeType: pdfMimeType,
      size: workingSize,
      version: pdfVersion,
      round
    }, { transaction: t });

    await ChangeLog.create({
      submissionId,
      userId,
      action: 'upload',
      step: 2,
      round,
      description
    }, { transaction: t });

    return fr;
  });

  logger.info('PDF uploaded', { submissionId, fileId: fileRecord.id, convertedFromWord: isWord, concatenated });

  return fileRecord;
}

/**
 * Upload a supplemental methods file (PDF or Word).
 * Stores the original file as `supplemental` and the PDF version as `supplemental_pdf`.
 * If the file is a Word document, it's converted to PDF first.
 *
 * @param {string} submissionId
 * @param {object} file - Multer file object
 * @param {string} userId
 * @param {number} round
 * @returns {Promise<object>} The supplemental_pdf File record
 */
async function uploadSupplemental(submissionId, file, userId, round = 1) {
  const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'manuscriptId'] });
  const manuscriptId = submission?.manuscriptId;
  const ext = path.extname(file.originalname).toLowerCase();

  // --- Store the original supplemental file (PDF or Word) ---
  const origVersion = await File.getLatestVersion(submissionId, FILE_TYPES.SUPPLEMENTAL, round) + 1;
  const origS3Key = generateS3Key(manuscriptId, submissionId, round, FILE_TYPES.SUPPLEMENTAL, file.originalname, origVersion);
  await s3Service.uploadFile(origS3Key, file.buffer, file.mimetype);

  await File.create({
    submissionId,
    type: FILE_TYPES.SUPPLEMENTAL,
    fileName: file.originalname,
    s3Key: origS3Key,
    mimeType: file.mimetype,
    size: file.size,
    version: origVersion,
    round
  });

  // --- Get or convert to PDF ---
  let pdfBuffer = file.buffer;
  let pdfFileName = file.originalname;
  let pdfMimeType = file.mimetype;
  let pdfSize = file.size;

  if (ext === '.docx' || ext === '.doc') {
    logger.info('Converting supplemental Word to PDF', { submissionId, originalName: file.originalname });
    pdfBuffer = await convertDocxToPdf(file.buffer);
    pdfFileName = file.originalname.replace(/\.(docx?|DOCX?)$/, '.pdf');
    pdfMimeType = 'application/pdf';
    pdfSize = pdfBuffer.length;
    logger.info('Supplemental Word converted to PDF', { submissionId, pdfSize });
  }

  // --- Store the PDF version ---
  const pdfVersion = await File.getLatestVersion(submissionId, FILE_TYPES.SUPPLEMENTAL_PDF, round) + 1;
  const pdfS3Key = generateS3Key(manuscriptId, submissionId, round, FILE_TYPES.SUPPLEMENTAL_PDF, pdfFileName, pdfVersion);
  await s3Service.uploadFile(pdfS3Key, pdfBuffer, pdfMimeType);

  const suppPdfRecord = await File.create({
    submissionId,
    type: FILE_TYPES.SUPPLEMENTAL_PDF,
    fileName: pdfFileName,
    s3Key: pdfS3Key,
    mimeType: pdfMimeType,
    size: pdfSize,
    version: pdfVersion,
    round
  });

  await ChangeLog.create({
    submissionId,
    userId,
    action: 'upload',
    step: 1,
    round,
    description: `Uploaded supplemental methods file: ${file.originalname}${ext !== '.pdf' ? ' (converted to PDF)' : ''}`
  });

  logger.info('Supplemental file uploaded', {
    submissionId,
    originalName: file.originalname,
    convertedFromWord: ext !== '.pdf',
    suppPdfId: suppPdfRecord.id
  });

  return suppPdfRecord;
}

/**
 * Queue PDF for analysis
 * @param {string} submissionId
 * @param {string} userId
 * @returns {Promise<object>} Analysis record
 */
async function queueAnalysis(submissionId, userId, round = 1) {
  // PDF Analysis is the consolidator — no downstream cascade today, but call
  // for consistency / future extensibility (e.g., DAS suggestions).
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.PDF_ANALYSIS, round);

  // Create SubmissionJob tracking record
  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.PDF_ANALYSIS,
    status: 'queued',
    round
  });

  // Add job to the queue
  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.PDF_ANALYSIS,
    {
      submissionId,
      userId,
      submissionJobId: submissionJob.id
    },
    {
      // retryLimit and expireIn derived from JOB_CONFIG (PDF_ANALYSIS_API_TIMEOUT)
    }
  );

  // Store pg-boss job ID
  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('PDF analysis queued', {
    submissionId,
    submissionJobId: submissionJob.id,
    jobId
  });

  return submissionJob;
}

/**
 * Apply add row change.
 * Atomic: the new KRT row + its audit-log entry are persisted in one
 * transaction so the audit log can never reference a row that doesn't exist
 * (or vice versa).
 */
async function applyAddRow(submissionId, data, userId, round) {
  await sequelize.transaction(async (t) => {
    const krtRow = await KRTData.create({
      submissionId,
      resourceType: data.resourceType,
      resourceName: data.resourceName,
      source: data.source,
      identifier: data.identifier,
      newReuse: data.newReuse,
      additionalInformation: data.additionalInformation,
      round: round || 1
    }, { transaction: t });

    await ChangeLog.create({
      submissionId,
      userId,
      action: 'add_row',
      source: 'ai_suggestion',
      step: 2,
      round: round || 1,
      rowId: krtRow.id,
      description: `Added row: ${data.resourceName}`
    }, { transaction: t });
  });
}

/**
 * Apply delete_row change - find the row and delete it
 */
async function applyDeleteRow(submissionId, data, userId, round) {
  let row;

  if (data.rowId) {
    const where = { submissionId, id: data.rowId };
    if (round !== undefined) where.round = round;
    row = await KRTData.findOne({ where });
  }

  // Fallback: match by resourceName
  if (!row && data.resourceName) {
    const where = { submissionId };
    if (round !== undefined) where.round = round;
    const rows = await KRTData.findAll({ where, order: [['createdAt', 'ASC']] });
    row = rows.find(r => {
      const rowName = (r.resourceName || '').toLowerCase().trim();
      return rowName === data.resourceName.toLowerCase().trim();
    });
    if (!row) {
      row = rows.find(r => {
        const rowName = (r.resourceName || '').toLowerCase();
        return rowName.includes(data.resourceName.toLowerCase());
      });
    }
  }

  if (!row) {
    throw new NotFoundError('KRT row');
  }

  // Atomic: log the deletion, clear ValidationResult rows referencing the
  // doomed row, then destroy it. Without a transaction, a mid-flow failure
  // could leave stale ValidationResult rows referencing a deleted row id, or
  // delete the row without an audit-log entry.
  await sequelize.transaction(async (t) => {
    await ChangeLog.create({
      submissionId,
      userId,
      action: 'delete_row',
      source: 'ai_suggestion',
      step: 2,
      round: round || 1,
      rowId: row.id,
      description: `Deleted row: ${row.resourceName}`,
      metadata: {
        resourceType: row.resourceType,
        resourceName: row.resourceName,
        source: row.source,
        identifier: row.identifier,
        newReuse: row.newReuse,
        additionalInformation: row.additionalInformation
      }
    }, { transaction: t });

    await ValidationResult.destroy({
      where: { submissionId, rowId: row.id },
      transaction: t
    });

    await row.destroy({ transaction: t });
  });
}

/**
 * Apply edit change
 */
async function applyEdit(submissionId, data, modifiedValue, userId, round) {
  let row;

  if (data.rowId) {
    // Direct lookup by UUID
    const where = { submissionId, id: data.rowId };
    if (round !== undefined) where.round = round;
    row = await KRTData.findOne({ where });
  }

  // Fallback: match by oldValue + column, or by resourceName
  // (for findings created before rowId was added)
  if (!row) {
    const columnMap = {
      'resource_type': 'resourceType',
      'resource_name': 'resourceName',
      'source': 'source',
      'identifier': 'identifier',
      'new_reuse': 'newReuse',
      'additional_information': 'additionalInformation',
      // Also support uppercase KRT column keys
      'RESOURCE TYPE': 'resourceType',
      'RESOURCE NAME': 'resourceName',
      'SOURCE': 'source',
      'IDENTIFIER': 'identifier',
      'NEW/REUSE': 'newReuse',
      'ADDITIONAL INFORMATION': 'additionalInformation'
    };
    const where = { submissionId };
    if (round !== undefined) where.round = round;
    const rows = await KRTData.findAll({ where, order: [['createdAt', 'ASC']] });

    // Try matching by resourceName first (most reliable)
    if (!row && data.resourceName) {
      row = rows.find(r => {
        const rowName = (r.resourceName || '').toLowerCase().trim();
        return rowName === data.resourceName.toLowerCase().trim();
      });
      // Lenient fallback: partial match
      if (!row) {
        row = rows.find(r => {
          const rowName = (r.resourceName || '').toLowerCase();
          return rowName.includes(data.resourceName.toLowerCase());
        });
      }
    }

    // Then try matching by oldValue on the target column
    if (!row && data.oldValue !== undefined && data.column) {
      const field = columnMap[data.column] || data.column;
      row = rows.find(r => {
        const cellValue = (r[field] || '').trim();
        const oldValue = (data.oldValue || '').trim();
        return cellValue === oldValue;
      });
    }
  }

  if (!row) {
    throw new NotFoundError('KRT row');
  }

  const columnMap = {
    'resource_type': 'resourceType',
    'resource_name': 'resourceName',
    'source': 'source',
    'identifier': 'identifier',
    'new_reuse': 'newReuse',
    'additional_information': 'additionalInformation'
  };

  const field = columnMap[data.column] || data.column;
  const oldValue = row[field];
  const newValue = modifiedValue || data.newValue;

  // Atomic: cell update + audit-log entry must both land or neither.
  await sequelize.transaction(async (t) => {
    row[field] = newValue;
    await row.save({ transaction: t });

    await ChangeLog.create({
      submissionId,
      userId,
      action: 'edit',
      source: 'ai_suggestion',
      step: 2,
      round: round || 1,
      rowId: row.id,
      columnName: data.column,
      oldValue,
      newValue
    }, { transaction: t });
  });
}

/**
 * Extract Data Availability Statement from the manuscript PDF.
 *
 * Runs the standard external→demo workflow. The DAS text (or "Not found" when
 * the workflow couldn't produce one) is always written to the submission so
 * the user sees that extraction was attempted.
 *
 * Helper-shaped result is returned for the worker.
 */
async function extractAndSaveDAS(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: dasExtractorConfig.isConfigured(),
    demoEnabled: process.env.PDF_DAS_EXTRACTOR_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => runDasExtractor(submission, jobLogger),
    getDemoData: async () => {
      const das = demoDataService.getDemoDAS(submission.manuscriptId);
      if (!das) return null;
      await jobLogger?.saveRawResponse('demo-das', { das });
      return { items: [{ das }], meta: { das, dasLength: das.length } };
    },
    isFinalAttempt,
    jobLogger
  });

  // Always persist *something* on the submission so the user sees that
  // extraction was attempted. "Not found" doubles as the empty-but-tried
  // sentinel and as the placeholder shown in the UI.
  const das = result.data?.meta?.das || null;
  const persisted = das || 'Not found';
  submission.extractedDataAvailabilityStatement = persisted;
  submission.dataAvailabilityStatement = persisted;
  await submission.save();

  logger.info('PDF_DAS_EXTRACTOR done', {
    submissionId,
    status: result.status, source: result.source,
    dasLength: das?.length || 0
  });

  return result;
}

/**
 * Call the external DAS extractor API. Returns the helper-shaped { items, meta }
 * with the DAS text in meta.das (so the worker can read it without reaching
 * into items).
 */
async function runDasExtractor(submission, jobLogger) {
  const submissionId = submission.id;

  const pdfFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.PDF },
    order: [['version', 'DESC']]
  });
  if (!pdfFile) throw new Error('No PDF file found for DAS extraction');

  const pdfBuffer = await s3Service.downloadFile(pdfFile.s3Key);
  jobLogger?.log('das_api_start', 'Calling DAS extractor API');
  const extractedDas = await dasExtractorClient.extractDAS(pdfBuffer, pdfFile.fileName);
  await jobLogger?.saveRawResponse('das-extractor-response', { das: extractedDas });
  jobLogger?.log('das_api_done', 'DAS extractor returned', { dasLength: extractedDas?.length || 0 });

  if (!extractedDas) {
    // External returned an empty DAS — still a valid "Done" outcome (status
    // distinguishes empty-from-external vs no-attempt).
    return { items: [], meta: { das: null, dasLength: 0 } };
  }

  return {
    items: [{ das: extractedDas }],
    meta: { das: extractedDas, dasLength: extractedDas.length }
  };
}

/**
 * Queue DAS extraction as a background job
 * @param {string} submissionId
 * @returns {Promise<string>} Job ID
 */
async function queueDASExtraction(submissionId, round = 1) {
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.DAS_EXTRACTION, round);

  // Create SubmissionJob tracking record
  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.DAS_EXTRACTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.DAS_EXTRACTION,
    {
      submissionId,
      submissionJobId: submissionJob.id
    },
    {
      // retryLimit and expireIn derived from JOB_CONFIG (PDF_DAS_EXTRACTOR_API_TIMEOUT)
    }
  );

  // Store pg-boss job ID
  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('DAS extraction queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

module.exports = {
  uploadPDF,
  uploadSupplemental,
  concatenatePDFs,
  queueAnalysis,
  extractAndSaveDAS,
  queueDASExtraction,
  // Apply helpers - exported for use by suggestion service
  applyAddRow,
  applyEdit,
  applyDeleteRow
};
