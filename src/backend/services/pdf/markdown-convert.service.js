/**
 * Markdown Convert Service
 *
 * Converts the manuscript PDF to Markdown via the configured provider, then
 * stores the Markdown as an S3 file record. Demo path uploads cached demo
 * markdown as if it had come from the real provider, so downstream jobs that
 * read the Markdown file are unaware of the source.
 */

const { Submission, File, SubmissionJob } = require('../../models');
const s3Service = require('../storage/s3.service');
const pdfMarkdownClient = require('./pdf-markdown-client.service');
const markdownFilter = require('./markdown-filter.service');
const markdownConfig = require('../../config/pdf-markdown-api');
const demoDataService = require('../demo-data.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { generateS3Key } = require('../../utils/helpers');
const { runWithDemoFallback } = require('../demo-fallback.service');
const logger = require('../../utils/logger');
const runInputs = require('../queue/run-inputs.service');

/**
 * Re-run the conversion, in the pipeline.
 *
 * Downstream is reset first — every detector reads this output, so they all
 * have to run again — and then the step is re-queued through the orchestrator
 * rather than by inserting a second row. Inserting was the shape of the bug
 * that shipped a Generated KRT with zero detections: `getForSubmission` keeps
 * only the newest row per type, so a rival row hides the pipeline's own and the
 * advancement that should have followed goes to the wrong row. It also
 * disagreed with `requeueStep` about in-flight work — a re-run while a
 * conversion was already running started a second one against the same file.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} [userId]
 * @returns {Promise<object>} the markdown_convert SubmissionJob row
 */
async function queueMarkdownConvert(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // returned row cannot tell a caller whether it started this run or found one
  // already going — the endpoints reported "already running" for runs they had
  // just started this instant.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.MARKDOWN_CONVERT, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.MARKDOWN_CONVERT, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.MARKDOWN_CONVERT, round, userId);

  logger.info('Markdown conversion re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

async function processMarkdownConvert(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: markdownConfig.isConfigured(),
    demoEnabled: process.env.PDF_MARKDOWN_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => convertMarkdownForSubmission(submission, jobLogger),
    getDemoData: () => loadDemoMarkdown(submission, jobLogger),
    isFinalAttempt,
    jobLogger
  });

  // Markdown convert stores no `items` per se; it's the side-effect (S3 file +
  // File row) that matters. The data field carries fileId + length for the UI.
  await persistJobData(submissionId, JOB_TYPES.MARKDOWN_CONVERT, submission.currentRound || 1, result);
  return result;
}

async function convertMarkdownForSubmission(submission, jobLogger) {
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const pdfFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.PDF, round },
    order: [['version', 'DESC']]
  });
  if (!pdfFile) throw new Error('No PDF file found for markdown conversion');

  jobLogger?.log('download_pdf', 'Downloading PDF from S3', { fileName: pdfFile.fileName, s3Key: pdfFile.s3Key });
  const pdfBuffer = await s3Service.downloadFile(pdfFile.s3Key);
  jobLogger?.log('download_pdf_done', 'PDF downloaded', { size: pdfBuffer.length });

  jobLogger?.log('convert_start', `Converting via ${markdownConfig.provider}`, { provider: markdownConfig.provider });
  const convertStartTime = Date.now();
  await runInputs.saveRunInputs(jobLogger, {
    documents: { pdf: runInputs.fileRef(pdfFile, pdfBuffer) },
    meta: { provider: markdownConfig.provider }
  });

  const rawMarkdown = await pdfMarkdownClient.convertToMarkdown(pdfBuffer, pdfFile.fileName);
  const convertMs = Date.now() - convertStartTime;
  jobLogger?.log('convert_done', 'Conversion complete', { markdownLength: rawMarkdown.length, durationMs: convertMs });

  // Optional post-conversion filter: drop numeric data-matrix blocks from
  // oversized markdown (gated by config; pass-through otherwise). The stored
  // markdown is what every downstream text detector reads.
  const { markdown, applied: filtered, stats: filterStats } = markdownFilter.applyFilter(rawMarkdown);
  if (filtered) {
    jobLogger?.log('markdown_filtered', 'Dropped numeric data blocks from markdown', filterStats);
  }

  const mdFileName = pdfFile.fileName.replace(/\.pdf$/i, '.md');
  const mdFile = await uploadMarkdownAsFile(submission, markdown, mdFileName);

  // Helper expects { items, meta }. Markdown convert uses items=[mdFile] so
  // isProductive returns true; the worker reads fileId from meta.
  return {
    items: [{ fileId: mdFile.id }],
    meta: {
      provider: markdownConfig.provider,
      markdownLength: markdown.length,
      rawMarkdownLength: rawMarkdown.length,
      filtered,
      filterStats: filtered ? filterStats : null,
      convertMs,
      totalMs: Date.now() - startTime,
      fileId: mdFile.id
    }
  };
}

async function loadDemoMarkdown(submission, jobLogger) {
  const demoMarkdown = demoDataService.getDemoMarkdown(submission.manuscriptId);
  if (!demoMarkdown) return null;

  const mdFileName = `demo-${submission.manuscriptId || submission.id}.md`;
  const mdFile = await uploadMarkdownAsFile(submission, demoMarkdown, mdFileName);

  jobLogger?.log('demo_uploaded', 'Demo markdown uploaded to S3', {
    markdownLength: demoMarkdown.length, fileId: mdFile.id
  });

  return {
    items: [{ fileId: mdFile.id }],
    meta: { provider: 'demo', markdownLength: demoMarkdown.length, fileId: mdFile.id }
  };
}

/**
 * Upload markdown text to S3 and create a File row. Used by both the external
 * and demo paths so downstream jobs (datasets, protocols) read the same shape.
 */
async function uploadMarkdownAsFile(submission, markdownText, mdFileName) {
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const mdBuffer = Buffer.from(markdownText, 'utf-8');

  const existingMdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  const nextVersion = existingMdFile ? existingMdFile.version + 1 : 1;

  const s3Key = generateS3Key(submission.manuscriptId, submissionId, round, FILE_TYPES.MARKDOWN, mdFileName, nextVersion);
  await s3Service.uploadFile(s3Key, mdBuffer, 'text/markdown');

  return File.create({
    submissionId,
    type: FILE_TYPES.MARKDOWN,
    fileName: mdFileName,
    s3Key,
    mimeType: 'text/markdown',
    size: mdBuffer.length,
    version: nextVersion,
    round
  });
}

async function persistJobData(submissionId, jobType, round, helperResult) {
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data: helperResult.data };
    job.changed('result', true);
    await job.save();
  }
}

module.exports = {
  queueMarkdownConvert,
  processMarkdownConvert
};
