/**
 * PDF Controller
 */

const pdfService = require('../services/pdf/pdf.service');
const orchestrator = require('../services/queue/orchestrator.service');
const { SubmissionJob, ChangeLog, Submission } = require('../models');
const suggestionService = require('../services/suggestion/suggestion.service');
const { JOB_TYPES } = require('../config/constants');
const { NotFoundError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');
const { describeQueueOutcome } = require('../utils/queue-message');

/**
 * Upload PDF
 * POST /api/submissions/:id/pdf/upload
 */
async function upload(req, res, next) {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    // Magic-byte check: reject anything that isn't a real PDF or DOCX (ZIP).
    // Guards against HTML/error pages being POSTed as a "PDF" (e.g. when the
    // frontend fetches a missing demo file and a fallback returns index.html).
    const buf = req.file.buffer;
    const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
    const isDocx = buf.length >= 4
      && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    if (!isPdf && !isDocx) {
      throw new ValidationError('Uploaded file is not a valid PDF or DOCX');
    }

    const submission = req.submission;
    const result = await pdfService.uploadPDF(
      submission.id,
      req.file,
      req.userId,
      submission.currentRound
    );

    // Status is now step-based and only changes on navigation
    // PDF upload state is tracked via the File records

    logger.info('PDF uploaded', { submissionId: submission.id });

    // Start the full processing pipeline (DAS → PDF analysis, Software detection in parallel)
    //
    // A replaced manuscript is named as such rather than passing as a restart:
    // the distinction is the whole reason the results differ, and it is one the
    // orchestrator cannot infer — it sees a full re-run either way. Version 1 is
    // left to default, so the round's first run reads `create_submission`.
    await orchestrator.runAllProcesses(submission.id, req.userId, submission.currentRound, {
      cause: result.version > 1 ? 'new_document' : undefined
    });

    res.json({
      message: 'PDF uploaded successfully',
      file: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Upload supplemental methods file
 * POST /api/submissions/:id/supplemental/upload
 */
async function uploadSupplemental(req, res, next) {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    // Magic-byte check before the bytes ever reach LibreOffice (.doc/.docx are
    // converted via libreoffice-convert). The multer filter only checks the
    // file extension, so without this an attacker could rename any payload to
    // .docx and feed it to the office parser. Allow real PDF, DOCX/ZIP, or
    // legacy DOC (OLE2 compound-file) signatures only.
    const buf = req.file.buffer;
    const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
    const isZip = buf.length >= 4
      && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    const isOle = buf.length >= 8
      && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
      && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1;
    if (!isPdf && !isZip && !isOle) {
      throw new ValidationError('Uploaded file is not a valid PDF, DOC, or DOCX');
    }

    const submission = req.submission;
    const result = await pdfService.uploadSupplemental(
      submission.id,
      req.file,
      req.userId,
      submission.currentRound
    );

    logger.info('Supplemental file uploaded', { submissionId: submission.id });

    res.json({
      message: 'Supplemental file uploaded successfully',
      file: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Extract DAS from uploaded PDF
 * POST /api/submissions/:id/pdf/extract-das
 */
async function extractDAS(req, res, next) {
  try {
    const submission = req.submission;

    // Re-run it as a PIPELINE STEP, like every other module.
    //
    // This used to call `extractAndSaveDAS` directly, inside the request. That
    // ran the extraction but left the pipeline untouched: the `das_extraction`
    // job row kept the PREVIOUS run's status, result, frozen inputs and prompt,
    // so the module page described a run that was no longer the latest one —
    // and nothing downstream re-ran, so consolidation and the Availability
    // check kept answers built from a statement that had just been replaced.
    //
    // `queueDASExtraction` reuses the round's row, cascades to the steps that
    // read the statement, and respects the gates. It also means the endpoint
    // answers immediately instead of holding the request open for the length of
    // an LM call.
    const { job, alreadyInFlight } = await pdfService.queueDASExtraction(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('DAS extraction queued', { submissionId: submission.id, status: job.status });

    res.status(202).json({
      message: alreadyInFlight
        ? 'Availability Statement extraction is already running'
        : 'Availability Statement extraction queued',
      status: job.status,
      submissionJobId: job.id
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get analysis status
 * GET /api/submissions/:id/pdf/analysis
 */
async function getAnalysisStatus(req, res, next) {
  try {
    const job = await SubmissionJob.getLatest(req.params.id, JOB_TYPES.PDF_ANALYSIS, req.submission.currentRound);

    if (!job) {
      return res.json({
        status: 'not_started',
        message: 'No analysis has been started'
      });
    }

    res.json({
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get LM findings
 * GET /api/submissions/:id/pdf/findings
 */
async function getFindings(req, res, next) {
  try {
    const job = await SubmissionJob.getLatest(req.params.id, JOB_TYPES.PDF_ANALYSIS, req.submission.currentRound);

    if (!job) {
      throw new NotFoundError('Analysis');
    }

    if (job.status !== 'complete') {
      return res.json({
        status: job.status,
        findings: [],
        message: 'Analysis not yet complete'
      });
    }

    // Suggestions are now derived as the diff between the Generated KRT
    // (this job's result) and the user's KRT, filtered by rejections.
    const { suggestions } = await suggestionService.getAllSuggestions(
      req.params.id,
      req.submission.currentRound
    );

    res.json({
      status: job.status,
      findings: suggestions,
      completedAt: job.completedAt
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Trigger analysis
 * POST /api/submissions/:id/pdf/analyze
 */
async function triggerAnalysis(req, res, next) {
  try {
    const submission = req.submission;

    // Allow re-running analysis from step_pdf or later (for manual re-runs)

    const { job: submissionJob, alreadyInFlight } = await pdfService.queueAnalysis(
      submission.id,
      submission.currentRound,
      req.userId
    );

    logger.info('PDF analysis queued', { submissionId: submission.id, submissionJobId: submissionJob.id });

    res.json({
      message: describeQueueOutcome('Analysis', submissionJob, alreadyInFlight),
      submissionJobId: submissionJob.id,
      status: submissionJob.status
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  upload,
  uploadSupplemental,
  getAnalysisStatus,
  getFindings,
  triggerAnalysis,
  extractDAS
};
