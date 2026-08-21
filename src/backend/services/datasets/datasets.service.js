/**
 * Datasets Detection Service
 *
 * Two-pass detection: langextract signals → Gemini consolidation. The whole
 * pipeline is wrapped in runExternal so a failure of either step (or a missing
 * markdown prereq) falls through the standard external→demo workflow.
 *
 * Three-step pipeline:
 *   1. detectDatasets(markdownText)        → raw Gemini consolidation items
 *                                            (langextract is an internal step
 *                                            of detect — the caller still sees
 *                                            a single raw output)
 *   2. buildKrtItemsDatasets(raw)          → canonical KrtEntry[]
 *                                            (transformConsolidatedItem lives
 *                                            here now, not in the JSON parser)
 *   3. dedupeKrtItems(items, 'datasets')   → one entry per logical resource
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
const langextractClient = require('./langextract-client.service');
const datasetsConfig = require('../../config/datasets-detection-api');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const { buildEvidenceIndex, attachEvidence } = require('../pdf-analysis/evidence.service');
const { resolveDetection, detectionPromptsExist } = require('../detection/resolve');
const { tagAuthorRows } = require('../detection/tag-author-rows');
const { assemblePayloadPrompt } = require('../detection/prompt-assembly');
const runInputs = require('../queue/run-inputs.service');
const { buildKrtItemFromLM } = require('../pdf-analysis/lm-resource.service');
const inputFreeze = require('../queue/input-freeze.service');
const { buildAuthorSeeds, splitKrtIdentifiers } = require('../krt/author-krt-seeds.service');
const { sanitizeJsonEscapes, salvageTruncatedObjects, extractJsonBlock, hasParseableBody } = require('../../utils/gemini-json');
const logger = require('../../utils/logger');
const { generateContentWithRetry } = require('../../utils/gemini');

const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const CONSOLIDATION_PROMPT_FILE = path.join(PROMPTS_DIR, 'blind', 'datasets-consolidation.txt');
let _consolidationPromptCache = null;

// gemini-2.5-flash allows 65536 output tokens. This was 32768, which a
// 133 KB manuscript exceeded mid-object: the JSON failed to parse and the
// module recorded 0 resources after 124s of work. Thinking stays disabled
// (commit 38a16db), so the whole budget goes to output.
const MAX_OUTPUT_TOKENS = 65536;

/**
 * Fallback only. The prompt a run actually uses comes from its strategy and is
 * passed in as an override; this file backs the no-override path (scripts, and
 * any caller that has no submission). Availability is decided by
 * detectionPromptsExist, which asks the submission's own pipeline.
 */
function hasConsolidationPrompt() {
  return fs.existsSync(CONSOLIDATION_PROMPT_FILE);
}

/**
 * Resolve the consolidation prompt. An explicit `override` (non-empty string)
 * wins — used by tuning/experiment scripts; otherwise the committed default
 * file is read once and cached.
 * @param {string} [override] - optional prompt text to use instead of the file
 * @returns {string}
 */
function getConsolidationPrompt(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  if (!_consolidationPromptCache) {
    if (!hasConsolidationPrompt()) {
      throw new Error(`Consolidation prompt file not found: ${CONSOLIDATION_PROMPT_FILE} — this prompt is version-controlled; restore it from git to enable datasets detection`);
    }
    _consolidationPromptCache = fs.readFileSync(CONSOLIDATION_PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded datasets consolidation prompt', {
      file: CONSOLIDATION_PROMPT_FILE,
      length: _consolidationPromptCache.length
    });
  }
  return _consolidationPromptCache;
}

/**
 * Re-run this step, in the pipeline.
 *
 * Through `requeueStep`: the round's own row is reused, and the step is only
 * enqueued when it is actually runnable — dependencies terminal, gates
 * satisfied. This used to INSERT a second row set straight to `queued`, which
 * is the shape of the bug that shipped a Generated KRT with zero detections:
 * `getForSubmission` keeps only the NEWEST row per type, so a rival row hides
 * the pipeline's own and the advancement that should follow lands on the wrong
 * one.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} [userId]
 * @returns {Promise<{job: object, alreadyInFlight: boolean}>}
 */
async function queueDatasetDetection(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.DATASETS_DETECTION, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.DATASETS_DETECTION, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.DATASETS_DETECTION, round, userId);

  logger.info('Datasets detection re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

async function processDatasetDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    isExternalEnabled: datasetsConfig.isConfigured() && detectionPromptsExist('datasets', submission),
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

  // The document this ROUND is reading, not whatever is newest right now.
  // The first step to ask freezes it; every later reader in the round is
  // handed the same one, so a file replaced mid-run cannot split the round.
  const mdFile = await inputFreeze.resolveFile(
    submissionId, round, inputFreeze.INPUT_KINDS.MARKDOWN, { jobType: JOB_TYPES.DATASETS_DETECTION }
  );
  if (!mdFile) throw new Error('No markdown file found for datasets detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', { fileName: mdFile.fileName, s3Key: mdFile.s3Key });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // ── Step 1: detect (langextract → Gemini)
  jobLogger?.log('extract_signals_start', 'Starting langextract signal extraction', { markdownLength: markdownText.length });
  const signalStartTime = Date.now();
  // Which prompts, and seeded from what. Datasets differs from the other two:
  // its seeds go into the payload's `author_provided_datasets` field, which the
  // seeded consolidation prompt reads by name, not into an appended block.
  const resolved = await resolveDetection('datasets', { submission, markdownText, jobLogger });
  if (!resolved.run) {
    return { items: [], meta: { totalCount: 0, skipped: true,
      reason: resolved.reason, pipeline: resolved.pipeline.id } };
  }

  const extractions = await langextractClient.extractSignals(markdownText, {
    prompt: resolved.input.signalsPrompt
  });
  const signalMs = Date.now() - signalStartTime;

  const datasetNames = langextractClient.collectDatasetNames(extractions);
  const allRows = langextractClient.buildExtractedRows(extractions);

  // Pass 1 is a GROUNDING stage, not just a recall stage: LangExtract aligns
  // each extraction to a span of the article. Anything it could not align did
  // not come from the article — in practice, the few-shot examples echoed back
  // out of the prompt. Those must not reach consolidation, where they would be
  // laundered into ordinary-looking candidate rows.
  const { grounded: extractedRows, ungrounded } = langextractClient.partitionByGrounding(allRows);

  jobLogger?.log('extract_signals_done', 'Signal extraction complete', {
    totalExtractions: extractions.length,
    datasetRowCount: extractedRows.length,
    ungroundedDropped: ungrounded.length,
    durationMs: signalMs
  });
  if (ungrounded.length > 0) {
    jobLogger?.log('extract_signals_ungrounded', 'Dropped signals not aligned to the article', {
      count: ungrounded.length,
      names: ungrounded.map((r) => r.attributes?.dataset_name).filter(Boolean).slice(0, 10)
    });
  }
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

  // Consolidation is KRT-blind: the author's rows are reconciled against this
  // output by the krt_grounding module, downstream. See
  // docs/design-krt-detection-two-modes.md.
  jobLogger?.log('consolidate_start', 'Starting Gemini consolidation', {
    datasetNameCount: datasetNames.length, extractedRowCount: extractedRows.length
  });
  const consolidationStartTime = Date.now();
  const { resources: rawItems, rawResponse, promptDigest } = await callGeminiForConsolidation(
    datasetNames, extractedRows, markdownText,
    { prompt: resolved.input.prompt, seeds: resolved.input.seeds }
  );
  const consolidationMs = Date.now() - consolidationStartTime;

  const cleanedConsolidation = extractJsonBlock(rawResponse);
  await jobLogger?.saveRawResponse('gemini-consolidation', cleanedConsolidation || rawResponse || rawItems);
  // Both passes are recorded: the signals prompt drives extraction, the
  // consolidation prompt drives the merge, and a run is only reproducible with
  // the pair. The extracted signals themselves are the `langextract-signals`
  // artefact beside this one.
  await runInputs.saveRunInputs(jobLogger, {
    documents: { markdown: runInputs.fileRef(mdFile, mdBuffer) },
    // The consolidation prompt embeds the DERIVED signals, not the raw
    // extractions — so the raw `langextract-signals` artefact beside this one is
    // not enough to rebuild it. One file has to be sufficient, or the digest
    // proves nothing on its own.
    frozen: {
      seeds: resolved.input.seeds || [],
      datasetNames,
      extractedRows
    },
    prompt: runInputs.promptRef(resolved.input.meta?.promptFile || null, promptDigest),
    // The few-shot examples are recorded as part of the signals prompt, not
    // beside it. LangExtract takes them as a separate argument and converts
    // them into structured ExampleData — they never enter the prompt text, so
    // the saved template alone would NOT reproduce this run. Editing the
    // examples changes the signals exactly as editing the prompt does.
    signalsPrompt: runInputs.promptRef(
      resolved.input.meta?.signalsPromptFile || null,
      null,
      [resolved.input.meta?.signalsExamplesFile].filter(Boolean)
    ),
    meta: {
      pipeline: resolved.pipeline.id,
      strategy: resolved.strategy.id,
      model: datasetsConfig.model,
      seedCount: resolved.input.meta?.seedCount ?? 0,
      signalCount: extractedRows.length
    }
  });

  // ── Step 2: buildKrtItems
  const krtItems = tagAuthorRows(buildKrtItemsDatasets(rawItems), resolved.input.seeds);

  // ── Step 3: ground every claim against the manuscript
  const evidenceIndex = buildEvidenceIndex(markdownText);
  const { items: groundedItems, stats: evidenceStats } = attachEvidence(krtItems, evidenceIndex, {
    label: 'datasets'
  });
  jobLogger?.log('evidence_grounding', 'Grounded dataset claims against the manuscript', evidenceStats);
  await jobLogger?.saveRawResponse('evidence-grounding', { stats: evidenceStats, items: groundedItems });

  // ── Step 4: dedupe
  const items = dedupeKrtItems(groundedItems, 'datasets-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;
  jobLogger?.log('consolidate_done', 'Consolidation complete', {
    resourceCount: items.length, highRelevanceCount, durationMs: consolidationMs
  });

  return {
    items,
    meta: {
      totalCount: items.length, uniqueCount: items.length, highRelevanceCount,
      signalExtractionCount: extractedRows.length,
      signalMs, consolidationMs,
      totalMs: Date.now() - startTime,
      model: datasetsConfig.model,
      pipeline: resolved.pipeline.id,
      strategy: resolved.strategy.id,
      // The prompt this run used, repo-relative, so the UI can link to it.
      promptFile: resolved.input.meta?.promptFile || null,
      signalsPromptFile: resolved.input.meta?.signalsPromptFile || null
    }
  };
}

async function callGeminiForConsolidation(datasetNames, extractedRows, markdownText, opts = {}) {
  // A bare prompt string for the pure/benchmark entry point, or {prompt, seeds}
  // from a strategy.
  const { prompt: promptOverride, seeds } = typeof opts === 'string' ? { prompt: opts } : opts;
  const ai = new GoogleGenAI({ apiKey: datasetsConfig.apiKey });
  const systemPrompt = getConsolidationPrompt(promptOverride);

  // `author_provided_datasets` is ALWAYS emitted, empty when unseeded: prompts
  // that do not reference the key ignore it, while a missing key breaks the
  // ones that do.
  const { prompt } = assemblePayloadPrompt({
    systemPrompt, seeds, datasetNames, extractedRows, markdownText
  });
  const promptDigest = { sha256: runInputs.sha256(prompt), bytes: Buffer.byteLength(prompt) };

  try {
    const response = await generateContentWithRetry(ai, {
      model: datasetsConfig.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Force complete, valid JSON and give the full token budget to output:
      // gemini-2.5-flash thinks by default, and on long consolidations that
      // thinking ate the budget and truncated the JSON mid-object.
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, {
      label: 'datasets consolidation',
      // An empty or unparseable body is a FAILED call, not "found
      // nothing" — retry it. The prompt states that an empty array is
      // how to report finding nothing, so a model with nothing to say
      // still has a valid answer available.
      validate: (res) => hasParseableBody(res?.text)
    });

    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      logger.warn('Gemini response truncated (datasets consolidation) — output hit maxOutputTokens');
    }

    const text = response.text;
    if (!hasParseableBody(text)) {
      // Every retry came back with nothing readable. Reporting zero
      // resources here would be a wrong answer presented as a finished
      // one: the job goes green with detected: false, indistinguishable
      // from a manuscript that genuinely mentions none.
      logger.error('Gemini returned no parseable body for datasets consolidation after retries');
      throw new ExternalServiceError('Gemini', 'empty or unparseable response after retries');
    }

    logger.debug('Gemini consolidation response preview', { preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text), rawResponse: text, promptDigest };
  } catch (error) {
    logger.error('Gemini API call failed for datasets consolidation', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
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
function parseGeminiResponse(text) {
  const jsonStr = sanitizeJsonEscapes(extractJsonBlock(text));

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
    // A response cut off by maxOutputTokens ends mid-object, so the whole body
    // fails to parse and every already-complete row would be lost. Recover
    // those rather than returning nothing.
    const salvaged = salvageTruncatedObjects(jsonStr);
    if (salvaged.length > 0) {
      logger.warn('Salvaged rows from a truncated Gemini response (datasets)', { count: salvaged.length });
      return salvaged;
    }
    return [];
  }
}

/**
 * Step 1: standalone two-pass detection. Runs langextract + Gemini and returns
 * the raw consolidation items (no canonical transform yet). No DB, no S3.
 *
 * @param {string} markdownText
 * @param {{ prompt?: string, signalsPrompt?: string, signalsExamples?: string|object }} [options]
 *   `prompt` overrides the Gemini consolidation prompt; `signalsPrompt` and
 *   `signalsExamples` override the langextract signal-extraction prompt and its
 *   few-shot examples JSON (all default to the committed file contents).
 * @returns {Promise<{ resources: object[], signalCount: number }>}
 */
async function detectDatasets(markdownText, { prompt, signalsPrompt, signalsExamples } = {}) {
  const extractions = await langextractClient.extractSignals(markdownText, {
    prompt: signalsPrompt,
    examples: signalsExamples
  });
  const datasetNames = langextractClient.collectDatasetNames(extractions);
  // Same grounding gate as the job path — see the comment there.
  const { grounded: extractedRows } = langextractClient.partitionByGrounding(
    langextractClient.buildExtractedRows(extractions)
  );

  if (extractedRows.length === 0) {
    return { resources: [], signalCount: extractions.length };
  }

  const { resources, rawResponse } = await callGeminiForConsolidation(datasetNames, extractedRows, markdownText, prompt);
  return { resources, signalCount: extractedRows.length, rawResponse };
}

function transformConsolidatedItem(item) {
  if (!item || typeof item !== 'object') return null;

  // Sub-type (e.g. "Microarray") becomes the stored context. Pre-refactor
  // datasets used `Type: ${subType}`; preserve that exact wording so the
  // consolidator output diffs cleanly.
  const subType = (item.subtype || item.resource_subtype || '').toString().trim()
    // Legacy demo items collapsed subType into resource_type; if resource_type
    // is NOT 'Dataset' we treat it as the subtype.
    || ((item.resource_type && item.resource_type !== 'Dataset') ? item.resource_type : '');
  const context = subType ? `Type: ${subType}` : (item.additionalInformation || '');

  const entry = buildKrtItemFromLM(item, {
    origin: 'datasets-gemini',
    defaultResourceType: 'Dataset',
    details: (raw) => ({
      subtype: subType || '',
      accessions: Array.isArray(raw.accessions) ? raw.accessions : [],
      dois: Array.isArray(raw.dois) ? raw.dois : [],
      urls: Array.isArray(raw.urls) ? raw.urls : [],
      datasetRole: raw.dataset_role || '',
      context
    })
  });
  if (!entry) return null;

  // Datasets are always typed as Dataset regardless of the sub-type the model
  // reported, and their identifier may arrive split across accessions/dois/urls
  // rather than as one string.
  entry.resourceType = 'Dataset';
  entry.identifier = (item.identifier && !Array.isArray(item.identifier))
    ? item.identifier
    : joinIdentifiers(item);
  entry.source = (item.repository || item.source || '').toString().trim();
  entry.newReuse = item.newReuse || item.new_reuse || mapDatasetRole(item.dataset_role);
  return entry;
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
  // Author-KRT helpers. These used to be a byte-for-byte copy of the shared
  // implementation living here as well; detection no longer consumes seeds, so
  // they are re-exported from the one source of truth for the dev scripts and
  // tests that still call them through this module.
  buildAuthorDatasetSeeds: buildAuthorSeeds,
  splitKrtIdentifiers
};
