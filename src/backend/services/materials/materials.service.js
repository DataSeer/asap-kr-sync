/**
 * Materials Detection Service
 *
 * Detects lab material/reagent mentions via Google Gemini on the manuscript
 * markdown (same input as protocols/datasets; only software still reads the PDF).
 *
 * Three-step pipeline:
 *   1. detectMaterials(markdownText)        → raw Gemini items (prompt-shape)
 *   2. buildKrtItemsMaterials(raw)          → canonical KrtEntry[]
 *   3. dedupeKrtItems(items, 'materials')   → one entry per logical resource
 *
 * Note: the curated enrichment list is no longer applied here — only the
 * Identifier Detection module consults the enrichment lists now.
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
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const { loadAuthorSeeds } = require('../krt/author-krt-seeds.service');
const { sanitizeJsonEscapes } = require('../../utils/gemini-json');
const logger = require('../../utils/logger');
const { generateContentWithRetry } = require('../../utils/gemini');

// KRT resource-type group for lab materials (0=dataset, 1=software, 2=protocol, 3=lab_material).
const MATERIAL_GROUP = 3;

const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'materials-detection.txt');
let _promptCache = null;

const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };
const DEFAULT_CONFIDENCE = 0.7;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

/**
 * Resolve the detection prompt. An explicit `override` (non-empty string) wins
 * — used by tuning/experiment scripts to run detection with a custom prompt;
 * otherwise the committed default file is read once and cached.
 * @param {string} [override] - optional prompt text to use instead of the file
 * @returns {string}
 */
function getPrompt(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — this prompt is version-controlled; restore it from git to enable materials detection`);
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

  // Materials detection is author-seeded only (request D): without author KRT
  // material rows the prompt has nothing to ground on and tends to be noisy, so
  // we skip the Gemini call entirely and return an empty result.
  const authorMaterials = await loadAuthorSeeds(submissionId, round, MATERIAL_GROUP);
  if (authorMaterials.length === 0) {
    jobLogger?.log('materials_skipped', 'No author KRT materials — skipping materials detection');
    return {
      items: [],
      meta: { totalCount: 0, uniqueCount: 0, highRelevanceCount: 0, skipped: true, reason: 'no_author_materials', totalMs: Date.now() - startTime }
    };
  }

  const mdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  if (!mdFile) throw new Error('No markdown file found for materials detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', { fileName: mdFile.fileName, s3Key: mdFile.s3Key });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // ── Step 1: detect (Gemini), seeded from the author's KRT materials
  jobLogger?.log('gemini_start', 'Calling Gemini API for materials detection', { authorSeedCount: authorMaterials.length });
  const geminiStartTime = Date.now();
  const { resources: rawItems, rawResponse } = await callGeminiForMaterials(markdownText, undefined, authorMaterials);
  const geminiMs = Date.now() - geminiStartTime;
  await jobLogger?.saveRawResponse('gemini-materials', rawResponse || rawItems);
  jobLogger?.log('gemini_done', 'Gemini response parsed', { resourceCount: rawItems.length, durationMs: geminiMs });

  // ── Step 2: buildKrtItems
  const krtItems = buildKrtItemsMaterials(rawItems);

  // ── Step 3: dedupe
  const items = dedupeKrtItems(krtItems, 'materials-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;

  return {
    items,
    meta: {
      totalCount: items.length,
      uniqueCount: items.length,
      highRelevanceCount,
      geminiMs,
      totalMs: Date.now() - startTime,
      model: materialsConfig.model
    }
  };
}

async function callGeminiForMaterials(markdownText, promptOverride, authorMaterials = []) {
  const ai = new GoogleGenAI({ apiKey: materialsConfig.apiKey });
  const prompt = getPrompt(promptOverride);
  // The prompt's Section 0 seeds from these. Omitted when empty so a custom
  // prompt override can still be run article-only by callers/benchmarks.
  const seedBlock = authorMaterials && authorMaterials.length > 0
    ? '\n\n---\n\nAUTHOR-PROVIDED MATERIALS (KRT):\n\n' + JSON.stringify(authorMaterials, null, 2)
    : '';
  const fullPrompt = prompt + seedBlock + '\n\n---\n\nARTICLE MARKDOWN:\n\n' + markdownText;

  try {
    const response = await generateContentWithRetry(ai, {
      model: materialsConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      // Force complete, valid JSON and give the full token budget to output:
      // gemini-2.5-flash thinks by default, and on long material lists that
      // thinking ate the budget and truncated the JSON mid-object.
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 32768,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, { label: 'materials' });

    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      logger.warn('Gemini response truncated (materials) — output hit maxOutputTokens');
    }

    const text = response.text;
    if (!text) {
      logger.warn('Gemini returned empty response for materials detection');
      return { resources: [], rawResponse: '' };
    }

    logger.debug('Gemini raw response preview (materials)', { preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text), rawResponse: text };
  } catch (error) {
    logger.error('Gemini API call failed for materials detection', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

function parseGeminiResponse(text) {
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  jsonStr = sanitizeJsonEscapes(jsonStr);

  try {
    const parsed = JSON.parse(jsonStr);
    const resources = parsed.resources || parsed;

    if (!Array.isArray(resources)) {
      logger.warn('Gemini response is not an array (materials)', { type: typeof resources });
      return [];
    }

    logger.info('Parsed materials from Gemini response', { count: resources.length });
    return resources;
  } catch (error) {
    logger.error('Failed to parse Gemini JSON response (materials)', {
      error: error.message, preview: jsonStr.substring(0, 300)
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure-ish, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: standalone Gemini call. Hits Gemini on the manuscript markdown and
 * returns the parsed resources array. No DB, no S3.
 * @param {string} markdownText - the full manuscript as markdown
 * @param {{ prompt?: string, authorMaterials?: object[] }} [options] - `prompt`
 *   overrides the default detection prompt; `authorMaterials` seeds the prompt's
 *   Section 0 with the author's KRT material rows (empty by default).
 * @returns {Promise<{ resources: object[], rawResponse?: string }>}
 */
async function detectMaterials(markdownText, { prompt, authorMaterials } = {}) {
  const { resources, rawResponse } = await callGeminiForMaterials(markdownText, prompt, authorMaterials || []);
  return { resources, rawResponse };
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
      // Leave ADDITIONAL INFORMATION empty for user-facing suggestions. The
      // detector's contextual info (the "why we picked this") is stashed in
      // detectorMeta.context for the internal team to inspect via the
      // background-processes panel; we don't want to push it into the KRT
      // where it competes with the user's own notes.
      additionalInformation: '',
      detectorMeta: {
        relevance,
        aliases: Array.isArray(r.aliases) ? r.aliases : [],
        context: r.additionalInformation || ''
      }
    };
  });
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
  buildKrtItemsMaterials
};
