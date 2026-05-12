/**
 * Datasets Detection Service
 *
 * Two-pass detection: langextract signals → Gemini consolidation. The whole
 * pipeline is wrapped in runExternal so a failure of either step (or a missing
 * markdown prereq) falls through the standard external→demo workflow.
 *
 * Four-step pipeline:
 *   1. detectDatasets(markdownText)        → raw Gemini consolidation items
 *                                            (langextract is an internal step
 *                                            of detect — the caller still sees
 *                                            a single raw output)
 *   2. buildKrtItemsDatasets(raw)          → canonical KrtEntry[]
 *                                            (transformConsolidatedItem lives
 *                                            here now, not in the JSON parser)
 *   3. enrichDatasets(items, {provider})   → blanks filled from curated list
 *   4. dedupeKrtItems(items, 'datasets')   → one entry per logical resource
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
// Sequelize models are lazy-loaded inside the worker functions below — see
// the matching comment in protocols.service.js for the rationale.
const s3Service = require('../storage/s3.service');
const langextractClient = require('./langextract-client.service');
const datasetsConfig = require('../../config/datasets-detection-api');
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
const CONSOLIDATION_PROMPT_FILE = path.join(PROMPTS_DIR, 'datasets-consolidation.txt');
let _consolidationPromptCache = null;

const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };
const DEFAULT_CONFIDENCE = 0.7;

function hasConsolidationPrompt() {
  return fs.existsSync(CONSOLIDATION_PROMPT_FILE);
}

function getConsolidationPrompt() {
  if (!_consolidationPromptCache) {
    if (!hasConsolidationPrompt()) {
      throw new Error(`Consolidation prompt file not found: ${CONSOLIDATION_PROMPT_FILE} — copy the .example file to enable datasets detection`);
    }
    _consolidationPromptCache = fs.readFileSync(CONSOLIDATION_PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded datasets consolidation prompt', {
      file: CONSOLIDATION_PROMPT_FILE,
      length: _consolidationPromptCache.length
    });
  }
  return _consolidationPromptCache;
}

async function queueDatasetDetection(submissionId, round = 1) {
  // Reset downstream dependents (PDF Analysis) to 'waiting' so they re-run
  // once this detection completes — keeps the Generated KRT in sync with the
  // freshly-produced detection items.
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.DATASETS_DETECTION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.DATASETS_DETECTION,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.DATASETS_DETECTION,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('Datasets detection queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

async function processDatasetDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: datasetsConfig.isConfigured() && hasConsolidationPrompt(),
    demoEnabled: process.env.DATASETS_DETECTION_DEMO_DATA_ENABLED !== 'false',
    runExternal: () => detectDatasetsForSubmission(submission, jobLogger),
    getDemoData: async () => {
      const demo = demoDataService.getDemoDatasetMentions(submission.manuscriptId);
      if (!demo || !demo.items?.length) return null;
      // Demo items use the post-transform legacy shape (resource_type='Dataset',
      // canonical_name, joined identifier). buildKrtItemsDatasets normalizes
      // them to canonical KrtEntry; dedupe matches the External path's shape.
      const krt = buildKrtItemsDatasets(demo.items);
      const items = dedupeKrtItems(krt, 'datasets-demo');
      await jobLogger?.saveRawResponse('demo-datasets', items);
      return {
        items,
        meta: { totalCount: items.length, uniqueCount: items.length }
      };
    },
    isFinalAttempt,
    jobLogger
  });

  await persistJobData(submissionId, JOB_TYPES.DATASETS_DETECTION, submission.currentRound || 1, result);
  return result;
}

/**
 * Run the full datasets pipeline. Throws if markdown is missing or either
 * external step fails — the helper turns those into demo fallback / Fail.
 */
async function detectDatasetsForSubmission(submission, jobLogger) {
  const { File } = require('../../models');
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  const mdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  if (!mdFile) throw new Error('No markdown file found for datasets detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', { fileName: mdFile.fileName, s3Key: mdFile.s3Key });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // ── Step 1: detect (langextract → Gemini)
  jobLogger?.log('extract_signals_start', 'Starting langextract signal extraction', { markdownLength: markdownText.length });
  const signalStartTime = Date.now();
  const extractions = await langextractClient.extractSignals(markdownText);
  const signalMs = Date.now() - signalStartTime;

  const datasetNames = langextractClient.collectDatasetNames(extractions);
  const extractedRows = langextractClient.buildExtractedRows(extractions);

  jobLogger?.log('extract_signals_done', 'Signal extraction complete', {
    totalExtractions: extractions.length, datasetRowCount: extractedRows.length, durationMs: signalMs
  });
  await jobLogger?.saveRawResponse('langextract-signals', extractions);

  // Empty result: still a valid External outcome (Done with 0 items).
  if (extractedRows.length === 0) {
    return {
      items: [],
      meta: {
        totalCount: 0, uniqueCount: 0, highRelevanceCount: 0,
        signalExtractionCount: 0, signalMs, totalMs: Date.now() - startTime
      }
    };
  }

  jobLogger?.log('consolidate_start', 'Starting Gemini consolidation', {
    datasetNameCount: datasetNames.length, extractedRowCount: extractedRows.length
  });
  const consolidationStartTime = Date.now();
  const { resources: rawItems, rawResponse } = await callGeminiForConsolidation(datasetNames, extractedRows, markdownText);
  const consolidationMs = Date.now() - consolidationStartTime;

  const cleanedConsolidation = stripMarkdownFences(rawResponse);
  await jobLogger?.saveRawResponse('gemini-consolidation', cleanedConsolidation || rawResponse || rawItems);

  // ── Step 2: buildKrtItems
  const krtItems = buildKrtItemsDatasets(rawItems);

  // ── Step 3: enrich
  jobLogger?.log('enrich_start', 'Enriching with curated datasets list');
  const { enriched, durationMs: enrichMs } = await enrichDatasets(krtItems, { provider: dbProvider });
  jobLogger?.log('enrich_done', 'Enrichment complete', { enrichMs });

  // ── Step 4: dedupe
  const items = dedupeKrtItems(enriched, 'datasets-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;
  jobLogger?.log('consolidate_done', 'Consolidation complete', {
    resourceCount: items.length, highRelevanceCount, durationMs: consolidationMs
  });

  return {
    items,
    meta: {
      totalCount: items.length, uniqueCount: items.length, highRelevanceCount,
      signalExtractionCount: extractedRows.length,
      signalMs, consolidationMs, enrichMs,
      totalMs: Date.now() - startTime,
      model: datasetsConfig.model
    }
  };
}

async function callGeminiForConsolidation(datasetNames, extractedRows, markdownText) {
  const ai = new GoogleGenAI({ apiKey: datasetsConfig.apiKey });
  const systemPrompt = getConsolidationPrompt();

  const userPayload = {
    dataset_names: datasetNames,
    extracted_dataset_rows: extractedRows,
    full_article: markdownText
  };

  const prompt = systemPrompt + '\n\nINPUT:\n' + JSON.stringify(userPayload, null, 0);

  try {
    const response = await ai.models.generateContent({
      model: datasetsConfig.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const text = response.text;
    if (!text) {
      logger.warn('Gemini returned empty response for datasets consolidation');
      return { resources: [], rawResponse: '' };
    }

    logger.debug('Gemini consolidation response preview', { preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text), rawResponse: text };
  } catch (error) {
    logger.error('Gemini API call failed for datasets consolidation', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

function stripMarkdownFences(text) {
  if (typeof text !== 'string') return '';
  let s = text.trim();
  if (!s.startsWith('```')) return s;
  s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return s.trim();
}

function mapDatasetRole(role) {
  const v = (role || '').toString().trim().toUpperCase();
  if (v === 'GENERATED') return 'new';
  if (v === 'REUSED') return 'reuse';
  return 'reuse';
}

function joinIdentifiers(item) {
  const parts = [];
  if (Array.isArray(item.accessions)) parts.push(...item.accessions);
  if (Array.isArray(item.dois)) parts.push(...item.dois);
  if (Array.isArray(item.urls)) parts.push(...item.urls);
  if (typeof item.identifier === 'string') parts.push(item.identifier);
  const seen = new Set();
  const unique = [];
  for (const raw of parts) {
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    unique.push(s);
  }
  return unique.join('; ');
}

/**
 * Convert one consolidated Gemini item (or legacy demo item, which already
 * carries the post-transform shape) into a canonical KrtEntry.
 *
 * Pure function. Returns null if the item lacks a canonical_name (matches the
 * pre-refactor behavior of `parseGeminiResponse`, which dropped these).
 */
function transformConsolidatedItem(item) {
  if (!item || typeof item !== 'object') return null;
  const resourceName = item.canonical_name || item.resourceName || item.name || '';
  if (!resourceName) return null;

  // Sub-type (e.g. "Microarray") becomes additionalInformation. Pre-refactor
  // datasets used `Type: ${subType}`; preserve that exact wording so the
  // consolidator output diffs cleanly.
  const subType = (item.subtype || item.resource_subtype || '').toString().trim() ||
                  // Legacy demo items already collapsed subType into resource_type;
                  // if resource_type is NOT 'Dataset' we treat it as the subtype.
                  ((item.resource_type && item.resource_type !== 'Dataset') ? item.resource_type : '');
  const additionalInformation = subType ? `Type: ${subType}` : (item.additionalInformation || '');

  // Identifier: legacy items already have it joined; raw Gemini items have
  // accessions/dois/urls separately. joinIdentifiers handles both shapes.
  const identifier = item.identifier && !Array.isArray(item.identifier)
    ? item.identifier
    : joinIdentifiers(item);

  const newReuse = item.newReuse || item.new_reuse || mapDatasetRole(item.dataset_role);
  const source = (item.repository || item.source || '').toString().trim();
  const relevance = item.krt_relevance || item.relevance || 'MEDIUM';

  return {
    resourceType: 'Dataset',
    resourceName,
    identifier,
    source,
    newReuse,
    origin: 'datasets-gemini',
    confidence: RELEVANCE_TO_CONFIDENCE[relevance] ?? DEFAULT_CONFIDENCE,
    additionalInformation,
    detectorMeta: {
      relevance,
      subtype: subType || '',
      accessions: Array.isArray(item.accessions) ? item.accessions : [],
      dois:       Array.isArray(item.dois)       ? item.dois       : [],
      urls:       Array.isArray(item.urls)       ? item.urls       : [],
      datasetRole: item.dataset_role || ''
    }
  };
}

function parseGeminiResponse(text) {
  const jsonStr = stripMarkdownFences(text);

  try {
    const parsed = JSON.parse(jsonStr);
    const resources = parsed.resources || parsed;

    if (!Array.isArray(resources)) {
      logger.warn('Gemini consolidation response is not an array', { type: typeof resources });
      return [];
    }

    logger.info('Parsed datasets from Gemini response', { count: resources.length });
    // Return raw items unchanged — buildKrtItemsDatasets handles the
    // transform-to-canonical step in the four-step pipeline.
    return resources;
  } catch (error) {
    logger.error('Failed to parse Gemini consolidation JSON response', {
      error: error.message, preview: jsonStr.substring(0, 300)
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline steps (pure-ish, exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: standalone two-pass detection. Runs langextract + Gemini and
 * returns the raw consolidation items (no canonical transform yet). No DB,
 * no S3.
 * @param {string} markdownText
 * @returns {Promise<{ resources: object[], signalCount: number }>}
 */
async function detectDatasets(markdownText) {
  const extractions = await langextractClient.extractSignals(markdownText);
  const datasetNames = langextractClient.collectDatasetNames(extractions);
  const extractedRows = langextractClient.buildExtractedRows(extractions);

  if (extractedRows.length === 0) {
    return { resources: [], signalCount: extractions.length };
  }

  const { resources } = await callGeminiForConsolidation(datasetNames, extractedRows, markdownText);
  return { resources, signalCount: extractedRows.length };
}

/**
 * Step 2: Gemini consolidation items → canonical KrtEntry[].
 *
 * Lifts `transformConsolidatedItem` out of the JSON parser. Filters out
 * items without a resourceName (matches the pre-refactor behavior).
 *
 * Pure function.
 *
 * @param {object[]} rawItems
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsDatasets(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map(transformConsolidatedItem).filter(Boolean);
}

/**
 * Step 3: fill blanks from the curated datasets list.
 * @param {object[]} items
 * @param {object} [options]
 * @param {object} [options.provider]
 * @returns {Promise<{ enriched: object[], durationMs: number }>}
 */
async function enrichDatasets(items, { provider = dbProvider } = {}) {
  const { enriched, durationMs } = await enrichmentListService.enrichMentions(
    'datasets', items, { provider }
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

async function getDatasetMentions(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.DATASETS_DETECTION, round);
  return job?.result?.data || null;
}

module.exports = {
  queueDatasetDetection,
  processDatasetDetection,
  getDatasetMentions,
  // Pipeline steps (pure-ish, exported for benchmarks/tests)
  detectDatasets,
  buildKrtItemsDatasets,
  enrichDatasets
};
