/**
 * Protocols Detection Service
 *
 * Detects protocol mentions via Google Gemini on the manuscript markdown.
 * Requires the MARKDOWN_CONVERT job to have completed first (markdown file).
 *
 * Four-step pipeline:
 *   1. detectProtocols(md)                 → raw Gemini items (prompt-shape)
 *   2. buildKrtItemsProtocols(raw)         → canonical KrtEntry[]
 *   3. attachEvidence(items, index)      → every row TAGGED verified /
 *                                          embellished / unsupported. Nothing
 *                                          is dropped here: the `drop` option
 *                                          is not implemented, and
 *                                          mergeDetections is what filters, at
 *                                          the cross-detector stage.
 *   4. dedupeKrtItems(items, 'protocols')  → one entry per logical resource
 *
 * Detection is KRT-blind: the author's own rows are NOT fed to the model. They
 * are reconciled against this output later, by the krt_grounding module. See
 * docs/background-modules.md.
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
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const { buildEvidenceIndex, attachEvidence } = require('../pdf-analysis/evidence.service');
const inputFreeze = require('../queue/input-freeze.service');
const { resolveDetection, detectionPromptsExist } = require('../detection/resolve');
const runInputs = require('../queue/run-inputs.service');
const { tagAuthorRows } = require('../detection/tag-author-rows');
const { assembleTextPrompt, SEED_TITLES } = require('../detection/prompt-assembly');
const { buildKrtItemsFromLM } = require('../pdf-analysis/lm-resource.service');
const { sanitizeJsonEscapes, salvageTruncatedObjects, hasParseableBody } = require('../../utils/gemini-json');
const logger = require('../../utils/logger');
const { generateContentWithRetry } = require('../../utils/gemini');

const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'blind', 'protocols-detection.txt');
let _promptCache = null;

// Same scale as identifier-detection.service.js — keeps confidence comparable
// across detectors when the merger picks representative fields.
// gemini-2.5-flash allows 65536 output tokens. This was 32768, which a
// 133 KB manuscript exceeded mid-object: the JSON failed to parse and the
// module recorded 0 resources after 124s of work. Thinking stays disabled
// (commit 38a16db), so the whole budget goes to output.
const MAX_OUTPUT_TOKENS = 65536;

const RELEVANCE_TO_CONFIDENCE = { HIGH: 0.95, MEDIUM: 0.7, LOW: 0.4 };
const DEFAULT_CONFIDENCE = 0.7;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

/**
 * Resolve the detection prompt. An explicit `override` (non-empty string) wins
 * — used by tuning/experiment scripts to run detection with a custom prompt;
 * otherwise the committed default file is read once and cached.
 *
 * Deleted by accident in 288ac67 (the requeueStep refactor) — it sat directly
 * above the queue function that commit rewrote, and went with it. Nothing
 * caught it: the only caller is inside the Gemini call, so every test that
 * mocks Gemini passes and `node --check` sees a perfectly valid file. What
 * caught it was `eslint --rule no-undef`, which is the cheap check worth
 * running on any commit that moves whole functions around.
 *
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
async function queueProtocolsDetection(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.PROTOCOLS_DETECTION, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.PROTOCOLS_DETECTION, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.PROTOCOLS_DETECTION, round, userId);

  logger.info('Protocols detection re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

async function processProtocolsDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    // Ask the strategy the SUBMISSION'S pipeline selects. This tested the
    // BLIND prompt while the default pipeline is seeded: a missing blind
    // file made a perfectly runnable seeded detection serve DEMO rows for a
    // real manuscript, and a missing seeded file was reported available and
    // then threw. Same fix datasets already had.
    isExternalEnabled: protocolsConfig.isConfigured() && detectionPromptsExist('protocols', submission),
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

  // The document this ROUND is reading, not whatever is newest right now.
  // The first step to ask freezes it; every later reader in the round is
  // handed the same one, so a file replaced mid-run cannot split the round.
  const mdFile = await inputFreeze.resolveFile(
    submissionId, round, inputFreeze.INPUT_KINDS.MARKDOWN, { jobType: JOB_TYPES.PROTOCOLS_DETECTION }
  );
  if (!mdFile) throw new Error('No markdown file found for protocols detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', { fileName: mdFile.fileName, s3Key: mdFile.s3Key });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // Detection is KRT-blind on purpose: the author's rows are reconciled against
  // this output by the krt_grounding module, downstream. Seeding the prompt with
  // them made the model echo seeds it had never located in the text, which made
  // "did we actually find this in the manuscript?" unanswerable.

  // ── Step 1: detect (Gemini)
  // Which prompt, and seeded from what — the strategy decides. Protocols runs
  // in both designs: with no seeds the seeded prompt's Section 0 simply has
  // nothing to base on, which is article-only and is dev's behaviour.
  const resolved = await resolveDetection('protocols', { submission, markdownText, jobLogger });
  if (!resolved.run) {
    return { items: [], meta: { totalCount: 0, uniqueCount: 0, skipped: true,
      reason: resolved.reason, pipeline: resolved.pipeline.id } };
  }

  jobLogger?.log('gemini_start', 'Calling Gemini API for protocols detection',
    { pipeline: resolved.pipeline.id, seedCount: resolved.input.meta?.seedCount ?? 0 });
  const geminiStartTime = Date.now();
  const { resources: rawItems, rawResponse, promptDigest } = await callGeminiForProtocols(markdownText, {
    prompt: resolved.input.prompt,
    seeds: resolved.input.seeds,
    seedTitle: resolved.strategy.seedTitle ? SEED_TITLES[resolved.strategy.seedTitle] : null
  });
  const geminiMs = Date.now() - geminiStartTime;

  // Only the parsed JSON is saved. There used to be a second
  // `gemini-protocols-analysis.md` artifact alongside it, from when the model
  // was expected to return prose around its JSON. It returns
  // `responseMimeType: 'application/json'` now, so that file was a byte-for-byte
  // duplicate of the .json under a misleading name.
  const extractedJson = stripMarkdownEscapes(extractJsonBlock(rawResponse));
  await jobLogger?.saveRawResponse('gemini-protocols', extractedJson || rawItems);
  await runInputs.saveRunInputs(jobLogger, {
    documents: { markdown: runInputs.fileRef(mdFile, mdBuffer) },
    frozen: { seeds: resolved.input.seeds || [] },
    prompt: runInputs.promptRef(resolved.input.meta?.promptFile || null, promptDigest),
    meta: {
      pipeline: resolved.pipeline.id,
      strategy: resolved.strategy.id,
      model: protocolsConfig.model,
      seedCount: resolved.input.meta?.seedCount ?? 0
    }
  });
  jobLogger?.log('gemini_done', 'Gemini response parsed', { resourceCount: rawItems.length, durationMs: geminiMs });

  // ── Step 2: buildKrtItems
  const krtItems = tagAuthorRows(buildKrtItemsProtocols(rawItems), resolved.input.seeds);

  // ── Step 3: ground every claim against the manuscript
  const evidenceIndex = buildEvidenceIndex(markdownText);
  const { items: groundedItems, stats: evidenceStats } = attachEvidence(krtItems, evidenceIndex, {
    label: 'protocols'
  });
  jobLogger?.log('evidence_grounding', 'Grounded protocol claims against the manuscript', evidenceStats);
  await jobLogger?.saveRawResponse('evidence-grounding', { stats: evidenceStats, items: groundedItems });

  // ── Step 4: dedupe
  const items = dedupeKrtItems(groundedItems, 'protocols-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;

  return {
    items,
    meta: {
      totalCount: items.length,
      uniqueCount: items.length,
      highRelevanceCount,
      geminiMs,
      totalMs: Date.now() - startTime,
      model: protocolsConfig.model,
      pipeline: resolved.pipeline.id,
      strategy: resolved.strategy.id,
      // The prompt this run used, repo-relative, so the UI can link to it.
      promptFile: resolved.input.meta?.promptFile || null,
      signalsPromptFile: resolved.input.meta?.signalsPromptFile || null
    }
  };
}

async function callGeminiForProtocols(markdownText, opts = {}) {
  const { prompt: promptOverride, seeds, seedTitle } =
    typeof opts === 'string' ? { prompt: opts } : opts;
  const ai = new GoogleGenAI({ apiKey: protocolsConfig.apiKey });
  const prompt = getPrompt(promptOverride);
  const fullPrompt = assembleTextPrompt({ prompt, seeds, seedTitle, markdownText });
  // Digested in place: the assembled prompt is the manuscript plus the
  // instructions, and only its hash needs to survive the call.
  const promptDigest = { sha256: runInputs.sha256(fullPrompt), bytes: Buffer.byteLength(fullPrompt) };

  try {
    const response = await generateContentWithRetry(ai, {
      model: protocolsConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      // Force complete, valid JSON and give the full token budget to output:
      // gemini-2.5-flash thinks by default, and on long protocol lists (with
      // long text_excerpts) that thinking ate the budget and truncated the JSON.
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, {
      label: 'protocols',
      // An empty or unparseable body is a FAILED call, not "found
      // nothing" — retry it. The prompt states that an empty array is
      // how to report finding nothing, so a model with nothing to say
      // still has a valid answer available.
      validate: (res) => hasParseableBody(res?.text)
    });

    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      logger.warn('Gemini response truncated (protocols) — output hit maxOutputTokens');
    }

    const text = response.text;
    if (!hasParseableBody(text)) {
      // Every retry came back with nothing readable. Reporting zero
      // resources here would be a wrong answer presented as a finished
      // one: the job goes green with detected: false, indistinguishable
      // from a manuscript that genuinely mentions none.
      logger.error('Gemini returned no parseable body for protocols detection after retries');
      throw new ExternalServiceError('Gemini', 'empty or unparseable response after retries');
    }

    logger.debug('Gemini raw response preview (protocols)', { preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text), rawResponse: text, promptDigest };
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
    // A response cut off by maxOutputTokens ends mid-object, so the whole
    // body fails to parse and every already-complete row would be lost.
    // Recover those rather than returning nothing.
    const salvaged = salvageTruncatedObjects(jsonStr);
    if (salvaged.length > 0) {
      logger.warn('Salvaged rows from a truncated Gemini response (protocols)', { count: salvaged.length });
      return salvaged;
    }
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
 * @param {{ prompt?: string }} [options] - `prompt` overrides the default
 *   detection prompt (used by the prompt-comparison scripts).
 * @returns {Promise<{ resources: object[] }>}
 */
async function detectProtocols(markdownText, { prompt } = {}) {
  const { resources, rawResponse } = await callGeminiForProtocols(markdownText, prompt);
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
  // The in-silico filter runs BEFORE the shared mapping: an entry the ASAP
  // rules class as Software/code should never become a Protocol KrtEntry.
  return buildKrtItemsFromLM(rawItems.filter(r => !isInSilicoProtocol(r)), {
    origin: 'protocols-gemini',
    defaultResourceType: 'Protocol',
    // `text_excerpt` is the prompt's ~200-char procedural snippet; the shared
    // contract already reads it as the evidence quote (FIELD_ALIASES). It is
    // also kept here because the panel surfaces it directly.
    details: (r) => ({
      text_excerpt: r.text_excerpt || '',
      context: r.additionalInformation || r.text_excerpt || '',
      section_heading: r.section_heading || ''
    })
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
    await job.persistData(helperResult.data);
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
