/**
 * Materials Detection Service
 *
 * Detects lab material/reagent mentions via Google Gemini on the manuscript
 * markdown (same input as protocols/datasets; only software still reads the PDF).
 *
 * Four-step pipeline:
 *   1. detectMaterials(markdownText)        → raw Gemini items (prompt-shape)
 *   2. buildKrtItemsMaterials(raw)          → canonical KrtEntry[]
 *   3. attachEvidence(items, index)      → every row TAGGED verified /
 *                                          embellished / unsupported. Nothing
 *                                          is dropped here: the `drop` option
 *                                          is not implemented, and
 *                                          mergeDetections is what filters, at
 *                                          the cross-detector stage.
 *   4. dedupeKrtItems(items, 'materials')   → one entry per logical resource
 *
 * Detection is KRT-blind and ALWAYS runs. It was previously author-seeded only
 * — skipped outright when the author listed no materials — which left the
 * module with no discovery capacity in the case that needs it most. The prompt
 * now works from textual cues; the author's rows are reconciled against this
 * output by the krt_grounding module. See docs/pipeline-modules.md.
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
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const demoDataService = require('../demo-data.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');
const { runWithDemoFallback } = require('../demo-fallback.service');
const { buildEvidenceIndex, attachEvidence } = require('../pdf-analysis/evidence.service');
const inputFreeze = require('../queue/input-freeze.service');
const { resolveDetection, detectionPromptsExist } = require('../detection/resolve');
const { tagAuthorRows } = require('../detection/tag-author-rows');
const { assembleTextPrompt, SEED_TITLES } = require('../detection/prompt-assembly');
const { buildKrtItemsFromLM } = require('../pdf-analysis/lm-resource.service');
const { sanitizeJsonEscapes, salvageTruncatedObjects, hasParseableBody } = require('../../utils/gemini-json');
const logger = require('../../utils/logger');
const frozenParams = require('../../utils/frozen-params');
const { generateContentWithRetry } = require('../../utils/gemini');
const runInputs = require('../queue/run-inputs.service');

const PROMPTS_DIR = path.join(__dirname, '../../data/prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'blind', 'materials-detection.txt');
let _promptCache = null;

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
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — this prompt is version-controlled; restore it from git to enable materials detection`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded materials detection prompt', { file: PROMPT_FILE, length: _promptCache.length });
  }
  // A restart asked to run with a past run's parameters uses THAT run's
  // template, not the file as it stands today. Resolved here, in every prompt
  // loader, because there is no shared one — and a loader that skipped this
  // would run the current prompt while the page said the run was reproduced.
  //
  // Returns `live` untouched outside a frozen restart, which is the normal path.
  return frozenParams.prompt(_promptCache);
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
async function queueMaterialsDetection(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.MATERIALS_DETECTION, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.MATERIALS_DETECTION, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.MATERIALS_DETECTION, round, userId);

  logger.info('Materials detection re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
}

async function processMaterialsDetection(submissionId, jobLogger = null, { isFinalAttempt = true } = {}) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const result = await runWithDemoFallback({
    // Ask the strategy the SUBMISSION'S pipeline selects. This tested the
    // BLIND prompt while the default pipeline is seeded: a missing blind
    // file made a perfectly runnable seeded detection serve DEMO rows for a
    // real manuscript, and a missing seeded file was reported available and
    // then threw. Same fix datasets already had.
    isExternalEnabled: materialsConfig.isConfigured() && detectionPromptsExist('materials', submission),
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

  // The document this ROUND is reading, not whatever is newest right now.
  // The first step to ask freezes it; every later reader in the round is
  // handed the same one, so a file replaced mid-run cannot split the round.
  const mdFile = await inputFreeze.resolveFile(
    submissionId, round, inputFreeze.INPUT_KINDS.MARKDOWN, { jobType: JOB_TYPES.MATERIALS_DETECTION }
  );
  if (!mdFile) throw new Error('No markdown file found for materials detection');

  jobLogger?.log('download_markdown', 'Downloading markdown from S3', { fileName: mdFile.fileName, s3Key: mdFile.s3Key });
  const mdBuffer = await s3Service.downloadFile(mdFile.s3Key);
  const markdownText = mdBuffer.toString('utf-8');
  jobLogger?.log('download_markdown_done', 'Markdown downloaded', { markdownLength: markdownText.length });

  // ── Step 0: which prompt, and seeded from what?
  //
  // The strategy owns both, including whether to run at all: the seeded design
  // is author-seeded ONLY, because a prompt framed as "re-ground and lightly
  // enrich the rows you were given" has nothing to do without them. The blind
  // design always runs. Putting that gate here instead would make one of the
  // two designs wrong, silently, by returning nothing.
  const resolved = await resolveDetection('materials', { submission, markdownText, jobLogger });
  if (!resolved.run) {
    return { items: [], meta: { totalCount: 0, uniqueCount: 0, highRelevanceCount: 0,
      skipped: true, reason: resolved.reason, pipeline: resolved.pipeline.id, totalMs: Date.now() - startTime } };
  }

  // ── Step 1: detect (Gemini)
  jobLogger?.log('gemini_start', 'Calling Gemini API for materials detection',
    { pipeline: resolved.pipeline.id, seedCount: resolved.input.meta?.seedCount ?? 0 });
  const geminiStartTime = Date.now();
  const { resources: rawItems, rawResponse, promptDigest } = await callGeminiForMaterials(markdownText, {
    prompt: resolved.input.prompt,
    seeds: resolved.input.seeds,
    // No seeds means the discovery prompt is in play, so there is no block to
    // title. seedBlock() already omits an empty block, but passing the title
    // here would be a lie about what the prompt expects.
    seedTitle: (resolved.strategy.seedTitle && resolved.input.seeds?.length)
      ? SEED_TITLES[resolved.strategy.seedTitle] : null
  });
  const geminiMs = Date.now() - geminiStartTime;
  await jobLogger?.saveRawResponse('gemini-materials', rawResponse || rawItems);
  // Frozen now, while the seeds are the ones this run was actually given: the
  // author can edit that table a minute later, and this record must not follow.
  await runInputs.saveRunInputs(jobLogger, {
    documents: { markdown: runInputs.fileRef(mdFile, mdBuffer) },
    frozen: { seeds: resolved.input.seeds || [] },
    prompt: runInputs.promptRef(resolved.input.meta?.promptFile || null, promptDigest),
    meta: {
      pipeline: resolved.pipeline.id,
      strategy: resolved.strategy.id,
      model: materialsConfig.model,
      seedCount: resolved.input.meta?.seedCount ?? 0
    },
    // Everything asked of the external service, sanitised: secrets
    // redacted, anything large replaced by its digest. Recorded whole rather
    // than hand-picked — a hand-picked list is one somebody has to remember
    // to extend, which is how four modules came to record no model at all.
    call: materialsConfig
  });
  jobLogger?.log('gemini_done', 'Gemini response parsed', { resourceCount: rawItems.length, durationMs: geminiMs });

  // ── Step 2: buildKrtItems
  const krtItems = tagAuthorRows(buildKrtItemsMaterials(rawItems), resolved.input.seeds);

  // ── Step 3: ground every claim against the manuscript
  const evidenceIndex = buildEvidenceIndex(markdownText);
  const { items: groundedItems, stats: evidenceStats } = attachEvidence(krtItems, evidenceIndex, {
    label: 'materials'
  });
  jobLogger?.log('evidence_grounding', 'Grounded material claims against the manuscript', evidenceStats);
  await jobLogger?.saveRawResponse('evidence-grounding', { stats: evidenceStats, items: groundedItems });

  // ── Step 4: dedupe
  const items = dedupeKrtItems(groundedItems, 'materials-gemini');

  const highRelevanceCount = items.filter(i => i.detectorMeta?.relevance === 'HIGH').length;

  return {
    items,
    meta: {
      totalCount: items.length,
      uniqueCount: items.length,
      highRelevanceCount,
      geminiMs,
      totalMs: Date.now() - startTime,
      model: materialsConfig.model,
      // Stamped on the result so a run records which configuration produced it.
      pipeline: resolved.pipeline.id,
      strategy: resolved.strategy.id,
      // The prompt this run used, repo-relative, so the UI can link to it.
      promptFile: resolved.input.meta?.promptFile || null,
      signalsPromptFile: resolved.input.meta?.signalsPromptFile || null
    }
  };
}

async function callGeminiForMaterials(markdownText, opts = {}) {
  // Accepts a bare prompt string for the pure/benchmark entry point, or the
  // {prompt, seeds, seedTitle} a strategy produced.
  const { prompt: promptOverride, seeds, seedTitle } =
    typeof opts === 'string' ? { prompt: opts } : opts;
  const ai = new GoogleGenAI({ apiKey: materialsConfig.apiKey });
  const fullPrompt = assembleTextPrompt({
    prompt: getPrompt(promptOverride), seeds, seedTitle, markdownText
  });
  // Hashed here, where the assembled prompt exists, rather than returned: it is
  // the manuscript plus the instructions, and it has no business travelling
  // back up the stack just to be digested.
  const promptDigest = { sha256: runInputs.sha256(fullPrompt), bytes: Buffer.byteLength(fullPrompt) };

  try {
    const response = await generateContentWithRetry(ai, {
      model: materialsConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      // Force complete, valid JSON and give the full token budget to output:
      // gemini-2.5-flash thinks by default, and on long material lists that
      // thinking ate the budget and truncated the JSON mid-object.
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, {
      label: 'materials',
      // An empty or unparseable body is a FAILED call, not "found
      // nothing" — retry it. The prompt states that an empty array is
      // how to report finding nothing, so a model with nothing to say
      // still has a valid answer available.
      validate: (res) => hasParseableBody(res?.text)
    });

    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      logger.warn('Gemini response truncated (materials) — output hit maxOutputTokens');
    }

    const text = response.text;
    if (!hasParseableBody(text)) {
      // Every retry came back with nothing readable. Reporting zero
      // resources here would be a wrong answer presented as a finished
      // one: the job goes green with detected: false, indistinguishable
      // from a manuscript that genuinely mentions none.
      logger.error('Gemini returned no parseable body for materials detection after retries');
      throw new ExternalServiceError('Gemini', 'empty or unparseable response after retries');
    }

    logger.debug('Gemini raw response preview (materials)', { preview: text.substring(0, 500) });
    return { resources: parseGeminiResponse(text), rawResponse: text, promptDigest };
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
    // A response cut off by maxOutputTokens ends mid-object, so the whole
    // body fails to parse and every already-complete row would be lost.
    // Recover those rather than returning nothing.
    const salvaged = salvageTruncatedObjects(jsonStr);
    if (salvaged.length > 0) {
      logger.warn('Salvaged rows from a truncated Gemini response (materials)', { count: salvaged.length });
      return salvaged;
    }
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
 * @param {{ prompt?: string }} [options] - `prompt` overrides the default
 *   detection prompt (used by the prompt-comparison scripts).
 * @returns {Promise<{ resources: object[], rawResponse?: string }>}
 */
async function detectMaterials(markdownText, { prompt, seeds, seedTitle } = {}) {
  // Seeds forwarded, not dropped — see the note on detectDatasets.
  const { resources, rawResponse } = await callGeminiForMaterials(markdownText, { prompt, seeds, seedTitle });
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
  return buildKrtItemsFromLM(rawItems, {
    origin: 'materials-gemini',
    defaultResourceType: 'Lab Material',
    // Materials carry no extras beyond the shared contract; the resource_type
    // enum in the prompt already captures antibody/cell line/organism/etc.
    details: (r) => ({ context: r.additionalInformation || '' })
  });
}

async function persistJobData(submissionId, jobType, round, helperResult) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    await job.persistData(helperResult.data);
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
