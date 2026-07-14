/**
 * Protocols Detection Service
 *
 * Detects protocol mentions via Google Gemini on the manuscript markdown.
 * Requires the MARKDOWN_CONVERT job to have completed first (markdown file).
 *
 * Three-step pipeline:
 *   1. detectProtocols(md)                 → raw Gemini items (prompt-shape)
 *   2. buildKrtItemsProtocols(raw)         → canonical KrtEntry[]
 *   3. dedupeKrtItems(items, 'protocols')  → one entry per logical resource
 *
 * Note: the curated enrichment list is no longer applied here — only the
 * Identifier Detection module consults the enrichment lists now.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
// Sequelize models are lazy-loaded inside the worker functions below. Top-
// level `require('../../models')` would parse DATABASE_URL at file load,
// which breaks `node --test` in CI environments where DATABASE_URL isn't
// set (the pure pipeline tests don't need the DB at all).
const s3Service = require('../storage/s3.service');
const protocolsConfig = require('../../config/protocols-detection-api');
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

// KRT resource-type group for protocols (0=dataset, 1=software, 2=protocol, 3=lab_material).
const PROTOCOL_GROUP = 2;

const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'protocols-detection.txt');
let _promptCache = null;

// Same scale as identifier-detection.service.js — keeps confidence comparable
// across detectors when the merger picks representative fields.
const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };
const DEFAULT_CONFIDENCE = 0.7;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

/**
 * Resolve the detection prompt. An explicit `override` (non-empty string) wins
 * — used by tuning/experiment scripts; otherwise the committed default file is
 * read once and cached.
 * @param {string} [override] - optional prompt text to use instead of the file
 * @returns {string}
 */
function getPrompt(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — this prompt is version-controlled; restore it from git to enable protocols detection`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded protocols detection prompt', { file: PROMPT_FILE, length: _promptCache.length });
  }
  return _promptCache;
}

async function queueProtocolsDetection(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.PROTOCOLS_DETECTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.PROTOCOLS_DETECTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.PROTOCOLS_DETECTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('Protocols detection queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

async function processProtocolsDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: protocolsConfig.isConfigured() && hasPrompt(),
    demoEnabled: process.env.PROTOCOLS_DETECTION_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => detectProtocolsForSubmission(submission, jobLogger),
    getDemoData: async () => {
      const demo = demoDataService.getDemoProtocolMentions(submission.manuscriptId);
      if (!demo || !demo.items?.length) return null;
      // Demo items use the legacy prompt-shape — run them through the same
      // build + dedupe steps so the output matches the External path.
      const krt = buildKrtItemsProtocols(demo.items);
      const items = dedupeKrtItems(krt, 'protocols-demo');
      const meta = {
        totalCount: items.length,
        uniqueCount: items.length,
        highRelevanceCount: items.filter(i => i.detectorMeta?.relevance === 'HIGH').length
      };
      await jobLogger?.saveRawResponse('demo-protocols', items);
      return { items, meta };
    },
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.PROTOCOLS_DETECTION, submission.currentRound || 1, result);
  return result;
}

async function detectProtocolsForSubmission(submission, jobLogger) {
  const { File } = require('../../models');
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const mdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  if (!mdFile) throw new Error('No markdown file found for protocols detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', { fileName: mdFile.fileName, s3Key: mdFile.s3Key });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // Seed from the author's KRT protocol rows (empty when there is no KRT —
  // article-only, unchanged behaviour). The prompt's Section 0 treats these as
  // authoritative base records so the LM enriches/adds instead of re-deriving.
  const authorProtocols = await loadAuthorSeeds(submissionId, round, PROTOCOL_GROUP);
  if (authorProtocols.length > 0) {
    jobLogger?.log('author_krt_seeds', 'Loaded author KRT protocol seeds', { count: authorProtocols.length });
  }

  // ── Step 1: detect (Gemini)
  jobLogger?.log('gemini_start', 'Calling Gemini API for protocols detection', { authorSeedCount: authorProtocols.length });
  const geminiStartTime = Date.now();
  const { resources: rawItems, rawResponse } = await callGeminiForProtocols(markdownText, undefined, authorProtocols);
  const geminiMs = Date.now() - geminiStartTime;

  await jobLogger?.saveRawResponse('gemini-protocols-analysis', rawResponse || '', {
    extension: '.md', mimeType: 'text/markdown'
  });
  const extractedJson = stripMarkdownEscapes(extractJsonBlock(rawResponse));
  await jobLogger?.saveRawResponse('gemini-protocols', extractedJson || rawItems);
  jobLogger?.log('gemini_done', 'Gemini response parsed', { resourceCount: rawItems.length, durationMs: geminiMs });

  // ── Step 2: buildKrtItems
  const krtItems = buildKrtItemsProtocols(rawItems);

  // ── Step 3: dedupe
  const items = dedupeKrtItems(krtItems, 'protocols-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;

  return {
    items,
    meta: {
      totalCount: items.length,
      uniqueCount: items.length,
      highRelevanceCount,
      geminiMs,
      totalMs: Date.now() - startTime,
      model: protocolsConfig.model
    }
  };
}

async function callGeminiForProtocols(markdownText, promptOverride, authorProtocols = []) {
  const ai = new GoogleGenAI({ apiKey: protocolsConfig.apiKey });
  const prompt = getPrompt(promptOverride);
  // Author-provided protocols are injected before the article so the prompt's
  // Section 0 can seed the output from them. Omitted entirely when empty so
  // article-only runs are byte-for-byte unchanged.
  const seedBlock = authorProtocols && authorProtocols.length > 0
    ? '\n\n---\n\nAUTHOR-PROVIDED PROTOCOLS (KRT):\n\n' + JSON.stringify(authorProtocols, null, 2)
    : '';
  const fullPrompt = prompt + seedBlock + '\n\n---\n\nARTICLE MARKDOWN:\n\n' + markdownText;

  try {
    const response = await generateContentWithRetry(ai, {
      model: protocolsConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      // Force complete, valid JSON and give the full token budget to output:
      // gemini-2.5-flash thinks by default, and on long protocol lists (with
      // long text_excerpts) that thinking ate the budget and truncated the JSON.
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 32768,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, { label: 'protocols' });

    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      logger.warn('Gemini response truncated (protocols) — output hit maxOutputTokens');
    }

    const text = response.text;
    if (!text) {
      logger.warn('Gemini returned empty response for protocols detection');
      return { resources: [], rawResponse: '' };
    }

    logger.debug('Gemini raw response preview (protocols)', { preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text), rawResponse: text };
  } catch (error) {
    logger.error('Gemini API call failed for protocols detection', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

function extractJsonBlock(text) {
  if (typeof text !== 'string') return '';
  const matches = [...text.matchAll(/```json\s*\n?([\s\S]*?)```/g)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  const plainMatches = [...text.matchAll(/```\s*\n?([\s\S]*?)```/g)];
  if (plainMatches.length > 0) {
    return plainMatches[plainMatches.length - 1][1].trim();
  }
  return text.trim();
}

// Strip markdown escapes Gemini sometimes inserts inside JSON string values
// (e.g. `\_` to avoid italic). Invalid in JSON — JSON.parse would throw.
function stripMarkdownEscapes(jsonStr) {
  return jsonStr.replace(/\\([^"\\/bfnrtu])/g, '$1');
}

function parseGeminiResponse(text) {
  const jsonStr = sanitizeJsonEscapes(stripMarkdownEscapes(extractJsonBlock(text)));

  try {
    const parsed = JSON.parse(jsonStr);
    const resources = parsed.resources || parsed;

    if (!Array.isArray(resources)) {
      logger.warn('Gemini response is not an array (protocols)', { type: typeof resources });
      return [];
    }

    logger.info('Parsed protocols from Gemini response', { count: resources.length });
    return resources;
  } catch (error) {
    logger.error('Failed to parse Gemini JSON response (protocols)', {
      error: error.message, preview: jsonStr.substring(0, 300)
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: hit Gemini on the markdown text and return the parsed resources
 * array. Pure-ish — no DB, no S3.
 * @param {string} markdownText
 * @param {{ prompt?: string, authorProtocols?: object[] }} [options] - `prompt`
 *   overrides the default detection prompt; `authorProtocols` seeds the prompt's
 *   Section 0 with the author's KRT protocol rows (empty by default).
 * @returns {Promise<{ resources: object[] }>}
 */
async function detectProtocols(markdownText, { prompt, authorProtocols } = {}) {
  const { resources, rawResponse } = await callGeminiForProtocols(markdownText, prompt, authorProtocols || []);
  return { resources, rawResponse };
}

/**
 * Step 2: Gemini prompt-shape items → canonical KrtEntry[].
 *
 * Pure function. Handles the (canonical_name | name | resourceName) +
 * (resource_type | resourceType) variations the prompt and demo data carry.
 * Detector-private fields (krt_relevance, text_excerpt, aliases) go on
 * `detectorMeta`.
 *
 * @param {object[]} rawItems
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsProtocols(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter(r => !isInSilicoProtocol(r))
    .map(r => {
      const resourceName = r.canonical_name || r.name || r.resourceName || '';
      const resourceType = r.resource_type || r.resourceType || 'Protocol';
      const relevance = r.krt_relevance || r.relevance || 'MEDIUM';
      return {
        resourceType,
        resourceName,
        identifier: r.identifier || '',
        source: r.source || '',
        newReuse: r.newReuse || r.new_reuse || '',
        origin: 'protocols-gemini',
        confidence: RELEVANCE_TO_CONFIDENCE[relevance] ?? DEFAULT_CONFIDENCE,
        // text_excerpt is the prompt-provided ~200-char snippet describing the
        // protocol use. Per ASAP request, do NOT push it into user-facing
        // ADDITIONAL INFORMATION — only the internal team needs that context.
        // Persisted on detectorMeta so the JobStatusPanel modal can still show it.
        additionalInformation: '',
        detectorMeta: {
          relevance,
          text_excerpt: r.text_excerpt || '',
          context: r.additionalInformation || r.text_excerpt || '',
          aliases: Array.isArray(r.aliases) ? r.aliases : []
        }
      };
    });
}

/**
 * Heuristic: drop "protocols" that are actually computational/in-silico
 * methods (e.g. "in silico docking", "computational simulation",
 * "in-silico binding study"). ASAP wants those classified as Software/code,
 * not Protocols. The detector prompt occasionally surfaces them anyway — this
 * post-filter is the safety net.
 *
 * Matches across resourceName and text_excerpt to catch both styles ("name:
 * In silico docking" vs. "context: …computational simulation of…").
 */
function isInSilicoProtocol(r) {
  const name = String(r?.canonical_name || r?.name || r?.resourceName || '').toLowerCase();
  const excerpt = String(r?.text_excerpt || r?.additionalInformation || '').toLowerCase();
  const COMPUTATIONAL_PATTERN = /\b(in[- ]silico|computational(?: method| modeling| simulation| analysis)?|simulation\b|molecular dynamics|monte carlo)\b/;
  return COMPUTATIONAL_PATTERN.test(name) || COMPUTATIONAL_PATTERN.test(excerpt);
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

async function getProtocolsMentions(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.PROTOCOLS_DETECTION, round);
  return job?.result?.data || null;
}

module.exports = {
  queueProtocolsDetection,
  processProtocolsDetection,
  getProtocolsMentions,
  // Pipeline steps (pure-ish, exported for benchmarks/tests)
  detectProtocols,
  buildKrtItemsProtocols
};
