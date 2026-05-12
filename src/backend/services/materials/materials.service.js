/**
 * Materials Detection Service
 *
 * Detects lab material/reagent mentions via Google Gemini on the manuscript PDF.
 *
 * Four-step pipeline:
 *   1. detectMaterials(pdfBuffer, fileName) → raw Gemini items (prompt-shape)
 *   2. buildKrtItemsMaterials(raw)          → canonical KrtEntry[]
 *   3. enrichMaterials(items, {provider})   → blanks filled from curated list
 *   4. dedupeKrtItems(items, 'materials')   → one entry per logical resource
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
// Sequelize models are lazy-loaded inside the worker functions below — see
// the matching comment in protocols.service.js for the rationale.
const s3Service = require('../storage/s3.service');
const materialsConfig = require('../../config/materials-detection-api');
const jobQueue = require('../queue/job-queue.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const enrichmentListService = require('../enrichment-list.service');
const { dbProvider } = require('../enrichment-list-providers');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const logger = require('../../utils/logger');

const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'materials-detection.txt');
let _promptCache = null;

const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };
const DEFAULT_CONFIDENCE = 0.7;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

function getPrompt() {
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — copy the .example file and customize it to enable materials detection`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded materials detection prompt', { file: PROMPT_FILE, length: _promptCache.length });
  }
  return _promptCache;
}

async function queueMaterialsDetection(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.MATERIALS_DETECTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.MATERIALS_DETECTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.MATERIALS_DETECTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('Materials detection queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

async function processMaterialsDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: materialsConfig.isConfigured() && hasPrompt(),
    demoEnabled: process.env.MATERIALS_DETECTION_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => detectMaterialsForSubmission(submission, jobLogger),
    getDemoData: async () => {
      const demo = demoDataService.getDemoLabMaterialMentions(submission.manuscriptId);
      if (!demo || !demo.items?.length) return null;
      const krt = buildKrtItemsMaterials(demo.items);
      const items = dedupeKrtItems(krt, 'materials-demo');
      const meta = {
        totalCount: items.length,
        uniqueCount: items.length,
        highRelevanceCount: items.filter(i => i.detectorMeta?.relevance === 'HIGH').length
      };
      await jobLogger?.saveRawResponse('demo-materials', items);
      return { items, meta };
    },
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.MATERIALS_DETECTION, submission.currentRound || 1, result);
  return result;
}

async function detectMaterialsForSubmission(submission, jobLogger) {
  const { File } = require('../../models');
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const pdfFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.PDF, round },
    order: [['version', 'DESC']]
  });
  if (!pdfFile) throw new Error('No PDF file found for materials detection');

  logger.info('Downloading PDF for materials detection', {
    submissionId, fileName: pdfFile.fileName, s3Key: pdfFile.s3Key
  });
  const pdfBuffer = await s3Service.downloadFile(pdfFile.s3Key);

  // ── Step 1: detect (Gemini)
  jobLogger?.log('gemini_start', 'Calling Gemini API for materials detection');
  const geminiStartTime = Date.now();
  const { resources: rawItems, rawResponse } = await callGeminiForMaterials(pdfBuffer, pdfFile.fileName);
  const geminiMs = Date.now() - geminiStartTime;
  await jobLogger?.saveRawResponse('gemini-materials', rawResponse || rawItems);
  jobLogger?.log('gemini_done', 'Gemini response parsed', { resourceCount: rawItems.length, durationMs: geminiMs });

  // ── Step 2: buildKrtItems
  const krtItems = buildKrtItemsMaterials(rawItems);

  // ── Step 3: enrich
  const { enriched, durationMs: enrichMs } = await enrichMaterials(krtItems, { provider: dbProvider });

  // ── Step 4: dedupe
  const items = dedupeKrtItems(enriched, 'materials-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;

  return {
    items,
    meta: {
      totalCount: items.length,
      uniqueCount: items.length,
      highRelevanceCount,
      geminiMs, enrichMs,
      totalMs: Date.now() - startTime,
      model: materialsConfig.model
    }
  };
}

async function callGeminiForMaterials(pdfBuffer, fileName) {
  const ai = new GoogleGenAI({ apiKey: materialsConfig.apiKey });
  const prompt = getPrompt();

  try {
    const response = await ai.models.generateContent({
      model: materialsConfig.model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } }
          ]
        }
      ]
    });

    const text = response.text;
    if (!text) {
      logger.warn('Gemini returned empty response for materials detection', { fileName });
      return { resources: [], rawResponse: '' };
    }

    logger.debug('Gemini raw response preview (materials)', { fileName, preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text, fileName), rawResponse: text };
  } catch (error) {
    logger.error('Gemini API call failed for materials detection', { fileName, error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

function parseGeminiResponse(text, fileName) {
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const resources = parsed.resources || parsed;

    if (!Array.isArray(resources)) {
      logger.warn('Gemini response is not an array (materials)', { fileName, type: typeof resources });
      return [];
    }

    logger.info('Parsed materials from Gemini response', { fileName, count: resources.length });
    return resources;
  } catch (error) {
    logger.error('Failed to parse Gemini JSON response (materials)', {
      fileName, error: error.message, preview: jsonStr.substring(0, 300)
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure-ish, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: standalone Gemini call. Hits Gemini on the PDF and returns the
 * parsed resources array. No DB, no S3.
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @returns {Promise<{ resources: object[] }>}
 */
async function detectMaterials(pdfBuffer, fileName) {
  const { resources } = await callGeminiForMaterials(pdfBuffer, fileName);
  return { resources };
}

/**
 * Step 2: Gemini prompt-shape items → canonical KrtEntry[].
 *
 * Pure function.
 *
 * @param {object[]} rawItems
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsMaterials(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map(r => {
    const resourceName = r.canonical_name || r.name || r.resourceName || '';
    const resourceType = r.resource_type || r.resourceType || 'Lab Material';
    const relevance = r.krt_relevance || r.relevance || 'MEDIUM';
    return {
      resourceType,
      resourceName,
      identifier: r.identifier || '',
      source: r.source || '',
      newReuse: r.newReuse || r.new_reuse || '',
      origin: 'materials-gemini',
      confidence: RELEVANCE_TO_CONFIDENCE[relevance] ?? DEFAULT_CONFIDENCE,
      additionalInformation: r.additionalInformation || '',
      detectorMeta: {
        relevance,
        aliases: Array.isArray(r.aliases) ? r.aliases : []
      }
    };
  });
}

/**
 * Step 3: fill blanks from the curated materials list.
 * @param {object[]} items
 * @param {object} [options]
 * @param {object} [options.provider]
 * @returns {Promise<{ enriched: object[], durationMs: number }>}
 */
async function enrichMaterials(items, { provider = dbProvider } = {}) {
  const { enriched, durationMs } = await enrichmentListService.enrichMentions(
    'materials', items, { provider }
  );
  const cleaned = enriched.map(e => {
    const { customListMatch, enrichmentMeta, ...rest } = e;
    return {
      ...rest,
      detectorMeta: {
        ...(rest.detectorMeta || {}),
        ...(enrichmentMeta ? { enrichmentMeta } : {}),
        ...(customListMatch ? { customListMatch } : {})
      }
    };
  });
  return { enriched: cleaned, durationMs };
}

async function persistJobData(submissionId, jobType, round, helperResult) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data: helperResult.data };
    job.changed('result', true);
    await job.save();
  }
}

async function getMaterialsMentions(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.MATERIALS_DETECTION, round);
  return job?.result?.data || null;
}

module.exports = {
  queueMaterialsDetection,
  processMaterialsDetection,
  getMaterialsMentions,
  // Pipeline steps (pure-ish, exported for benchmarks/tests)
  detectMaterials,
  buildKrtItemsMaterials,
  enrichMaterials
};
