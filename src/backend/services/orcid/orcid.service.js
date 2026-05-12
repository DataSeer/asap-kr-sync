/**
 * ORCID Extraction Service
 *
 * Three-step pipeline:
 *   1. GROBID — extract DOI, authors, affiliations, sometimes ORCIDs from PDF header
 *   2. OpenAlex — enrich with verified author-ORCID pairs matched by DOI
 *   3. ORCID API (optional) — fallback search by name + affiliation for unmatched authors
 *
 * No demo data exists for ORCID extraction yet; getDemoData returns null.
 */

const { Submission, File, SubmissionJob } = require('../../models');
const s3Service = require('../storage/s3.service');
const grobidClient = require('./grobid-client.service');
const openalexClient = require('./openalex-client.service');
const orcidApiClient = require('./orcid-api-client.service');
const grobidConfig = require('../../config/grobid-api');
const orcidApiConfig = require('../../config/orcid-api');
const jobQueue = require('../queue/job-queue.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { runWithDemoFallback } = require('../demo-fallback.service');
const logger = require('../../utils/logger');

/** Max authors to search via ORCID API fallback */
const ORCID_API_MAX_AUTHORS = 10;

function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Match a GROBID author to an OpenAlex author by name similarity:
 * first letter of first name + exact last name match.
 */
function findOpenAlexMatch(grobidAuthor, oaAuthors) {
  const gLastName = normalizeName(grobidAuthor.lastName);
  const gFirstLetter = normalizeName(grobidAuthor.firstName)?.[0] || '';

  if (!gLastName) return null;

  for (const oaAuthor of oaAuthors) {
    const oaLastName = normalizeName(oaAuthor.lastName);
    const oaFirstLetter = normalizeName(oaAuthor.firstName)?.[0] || '';

    if (gLastName === oaLastName && gFirstLetter && oaFirstLetter && gFirstLetter === oaFirstLetter) {
      return oaAuthor;
    }
  }

  return null;
}

async function processOrcidExtraction(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: grobidConfig.isConfigured(),
    demoEnabled: process.env.ORCID_EXTRACTION_DEMO_DATA_ENABLED === 'true',
    runExternal: () => extractAuthorsForSubmission(submission, jobLogger),
    getDemoData: async () => null, // No demo data for ORCIDs yet
    isFinalAttempt,
    jobLogger
  });

  // Authors are stored on the Submission (not the SubmissionJob) — preserve
  // existing reads from submission.authors.
  submission.authors = {
    items: result.data.items || [],
    meta: result.data.meta || {}
  };
  await submission.save();

  return result;
}

/**
 * Run GROBID + OpenAlex + ORCID API. Throws on missing PDF or upstream error.
 */
async function extractAuthorsForSubmission(submission, jobLogger) {
  const submissionId = submission.id;
  const round = submission.currentRound || 1;

  const pdfFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.PDF, round },
    order: [['version', 'DESC']]
  });
  if (!pdfFile) throw new Error('No PDF file found for ORCID extraction');

  logger.debug('ORCID extraction: downloading PDF from S3', {
    submissionId, s3Key: pdfFile.s3Key, fileName: pdfFile.fileName
  });
  const pdfBuffer = await s3Service.downloadFile(pdfFile.s3Key);
  logger.debug('ORCID extraction: PDF downloaded', { submissionId, pdfSize: pdfBuffer?.length || 0 });

  // Step 1: GROBID header extraction
  jobLogger?.log('grobid_start', 'Sending PDF to GROBID for header extraction');
  const grobidResult = await grobidClient.extractHeader(pdfBuffer, pdfFile.fileName);
  const { doi, authors: grobidAuthors } = grobidResult;
  await jobLogger?.saveRawResponse('grobid-header', {
    doi, authors: grobidAuthors, rawLength: grobidResult.raw?.length || 0
  });

  logger.info('ORCID extraction: GROBID step done', {
    submissionId, doi,
    grobidAuthorCount: grobidAuthors.length,
    grobidOrcidCount: grobidAuthors.filter(a => a.orcid).length,
    grobidMs: grobidResult.durationMs
  });

  // Step 2: OpenAlex enrichment (if DOI found)
  let openalexResult = { authors: [], durationMs: 0 };
  if (doi) {
    jobLogger?.log('openalex_start', 'Looking up authors via OpenAlex', { doi });
    openalexResult = await openalexClient.lookupByDoi(doi);
    await jobLogger?.saveRawResponse('openalex-response', openalexResult.authors);
    logger.info('ORCID extraction: OpenAlex step done', {
      submissionId, doi,
      oaAuthorCount: openalexResult.authors.length,
      oaOrcidCount: openalexResult.authors.filter(a => a.orcid).length,
      openalexMs: openalexResult.durationMs
    });
  } else {
    logger.info('ORCID extraction: skipping OpenAlex (no DOI from GROBID)', { submissionId });
  }

  // Step 3: Merge GROBID + OpenAlex authors
  const mergedAuthors = [];
  for (const gAuthor of grobidAuthors) {
    const oaMatch = findOpenAlexMatch(gAuthor, openalexResult.authors);

    let orcid = gAuthor.orcid || null;
    let source = null;
    let confidence = null;

    if (oaMatch?.orcid) {
      if (gAuthor.orcid && gAuthor.orcid === oaMatch.orcid) {
        source = 'grobid+openalex';
        confidence = 'high';
        orcid = oaMatch.orcid;
      } else {
        source = 'openalex';
        confidence = 'high';
        orcid = oaMatch.orcid;
      }
    } else if (gAuthor.orcid) {
      source = 'grobid';
      confidence = 'medium';
    }

    mergedAuthors.push({
      firstName: gAuthor.firstName,
      lastName: gAuthor.lastName,
      fullName: [gAuthor.firstName, gAuthor.lastName].filter(Boolean).join(' '),
      orcid,
      affiliation: gAuthor.affiliation,
      source,
      confidence
    });
  }

  const afterMergeOrcidCount = mergedAuthors.filter(a => a.orcid).length;
  logger.info('ORCID extraction: merge step done', {
    submissionId, authorCount: mergedAuthors.length,
    orcidCount: afterMergeOrcidCount,
    bySource: {
      'grobid+openalex': mergedAuthors.filter(a => a.source === 'grobid+openalex').length,
      openalex: mergedAuthors.filter(a => a.source === 'openalex').length,
      grobid: mergedAuthors.filter(a => a.source === 'grobid').length,
      none: mergedAuthors.filter(a => !a.source).length
    }
  });

  // Step 4: ORCID API fallback for unmatched authors
  let orcidApiMs = 0;
  if (orcidApiConfig.isConfigured()) {
    const unmatchedAuthors = mergedAuthors.filter(a => !a.orcid);
    const toSearch = unmatchedAuthors.slice(0, ORCID_API_MAX_AUTHORS);

    if (toSearch.length > 0) {
      logger.info('ORCID extraction: searching ORCID API for unmatched authors', {
        submissionId, unmatchedCount: unmatchedAuthors.length, searchingCount: toSearch.length
      });

      const orcidApiStart = Date.now();
      const results = await Promise.allSettled(
        toSearch.map(author =>
          orcidApiClient.searchByName(author.firstName, author.lastName, author.affiliation)
        )
      );
      orcidApiMs = Date.now() - orcidApiStart;

      let orcidApiFound = 0;
      for (let i = 0; i < toSearch.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          toSearch[i].orcid = result.value;
          toSearch[i].source = 'orcid_api';
          toSearch[i].confidence = 'medium';
          orcidApiFound++;
        }
      }

      logger.info('ORCID extraction: ORCID API step done', {
        submissionId, searched: toSearch.length, found: orcidApiFound, orcidApiMs
      });
    } else {
      logger.debug('ORCID extraction: no unmatched authors for ORCID API fallback', { submissionId });
    }
  } else {
    logger.debug('ORCID extraction: ORCID API disabled, skipping fallback', { submissionId });
  }

  const orcidCount = mergedAuthors.filter(a => a.orcid).length;
  return {
    items: mergedAuthors,
    meta: {
      authorCount: mergedAuthors.length,
      orcidCount,
      doi: doi || null,
      grobidMs: grobidResult.durationMs,
      openalexMs: openalexResult.durationMs,
      orcidApiMs,
      totalMs: grobidResult.durationMs + openalexResult.durationMs + orcidApiMs,
      grobidRawLength: grobidResult.raw?.length || 0
    }
  };
}

async function queueOrcidExtraction(submissionId, round = 1) {
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.ORCID_EXTRACTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.ORCID_EXTRACTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.ORCID_EXTRACTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('ORCID extraction queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

async function getAuthors(submissionId) {
  const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'authors'] });
  if (!submission) throw new NotFoundError('Submission');
  return submission.authors || { items: [], meta: null };
}

module.exports = {
  processOrcidExtraction,
  queueOrcidExtraction,
  getAuthors
};
