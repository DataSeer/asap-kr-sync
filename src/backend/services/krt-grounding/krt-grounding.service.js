/**
 * KRT Grounding — reconcile the author's Key Resources Table against what the
 * detectors actually found in the manuscript.
 *
 * This module answers the question the app exists to answer: **for every row
 * the author wrote, is it in the PDF, and does their row carry everything the
 * PDF says about it?** It runs after every detector and before consolidation.
 *
 * Two jobs used to be fused into one LM call. Detection was seeded with the
 * author's rows and told to "emit one row for every author-provided material,
 * never drop one" — so the model could echo a seed it had never located, and
 * the output looked identical either way. That made grounding unverifiable and
 * suppressed discovery at the same time. Here the two are separate: detection
 * is KRT-blind (see docs/design-krt-detection-two-modes.md), and the author's
 * table arrives here as a QUERY, never as a seed.
 *
 * Per author row the outcome is one of:
 *   - `confirmed`     — matched a grounded candidate; the row is complete
 *   - `incomplete`    — matched, but the manuscript supplies a field the row leaves EMPTY
 *   - `not_detected`  — nothing in the manuscript matched it
 *
 * **The author's data is never modified.** `not_detected` is a tag, not a
 * deletion; `incomplete` proposes a fill for an empty cell and nothing else.
 * Acting on either stays a human decision, made downstream in the suggestions UI.
 *
 * Both usage modes run this identical path: with no author KRT there are simply
 * zero rows to reconcile and every candidate is reported as unmatched.
 *
 * Pipeline:
 *   1. load author KRT rows + the candidate pool from every detector
 *   2. matchAuthorRows(...)          → deterministic outcomes (identifier → alias → name)
 *   3. secondLook(...)               → one batched LM pass over the not_detected rows
 *   4. persist outcomes + S3 artifacts
 */

const { GoogleGenAI } = require('@google/genai');
// Sequelize models are lazy-loaded inside the worker functions below — see the
// matching comment in protocols.service.js for the rationale.
const fs = require('fs');
const path = require('path');
const s3Service = require('../storage/s3.service');
const groundingConfig = require('../../config/krt-grounding-api');
const jobQueue = require('../queue/job-queue.service');
const { FILE_TYPES, JOB_TYPES } = require('../../config/constants');
const { NotFoundError } = require('../../utils/errors');
const { matchAuthorRows } = require('./match-author-rows.service');
const { buildEvidenceIndex, locateQuote } = require('../pdf-analysis/evidence.service');
const { sanitizeJsonEscapes } = require('../../utils/gemini-json');
const { generateContentWithRetry } = require('../../utils/gemini');
const logger = require('../../utils/logger');

const PROMPT_FILE = path.join(__dirname, '../../data/prompts/krt-grounding-second-look.txt');
let _promptCache = null;

/**
 * Detector jobs whose items form the candidate pool. Mirrors PDF Analysis's
 * CONTRIBUTOR_SOURCES — both consume the same detector output.
 */
const CONTRIBUTOR_SOURCES = [
  { source: 'software_detection', jobType: JOB_TYPES.SOFTWARE_DETECTION },
  { source: 'datasets_detection', jobType: JOB_TYPES.DATASETS_DETECTION },
  { source: 'materials_detection', jobType: JOB_TYPES.MATERIALS_DETECTION },
  { source: 'protocols_detection', jobType: JOB_TYPES.PROTOCOLS_DETECTION },
  { source: 'identifier_detection', jobType: JOB_TYPES.IDENTIFIER_DETECTION }
];

/** Author rows sent to the LM in one request. Keeps the response well inside the output cap. */
const SECOND_LOOK_BATCH_SIZE = 25;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

function getPrompt(override) {
  if (override != null && String(override).trim()) return String(override).trim();
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — restore it from git to enable the grounding second look`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
  }
  return _promptCache;
}

/**
 * Queue a standalone re-run (used by the "restart process" action).
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<string>} pg-boss job id
 */
async function queueKrtGrounding(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.KRT_GROUNDING, round);

  const submissionJob = await SubmissionJob.create({
    submissionId,
    jobType: JOB_TYPES.KRT_GROUNDING,
    status: 'queued',
    round
  });

  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.KRT_GROUNDING,
    { submissionId, submissionJobId: submissionJob.id }
  );

  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();

  logger.info('KRT grounding queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

/**
 * Worker entry point. Same signature as every other module's processX.
 *
 * Deliberately NOT wrapped in runWithDemoFallback: grounding has no external
 * dependency of its own to fall back FROM. The deterministic matcher always
 * runs; only the optional LM second look can fail, and it degrades to "no
 * second look" rather than failing the job (a row stays `not_detected`, which
 * is a truthful answer, just a less informed one).
 *
 * @param {string} submissionId
 * @param {object} [jobLogger]
 * @returns {Promise<{ data: object, source: string, status: string }>}
 */
async function processKrtGrounding(submissionId, jobLogger = null) {
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');

  const data = await groundSubmission(submission, jobLogger);
  await persistJobData(submissionId, JOB_TYPES.KRT_GROUNDING, submission.currentRound || 1, data);

  return { data, source: 'internal', status: 'done' };
}

/**
 * Run grounding for one submission/round.
 * @param {object} submission
 * @param {object} [jobLogger]
 * @returns {Promise<object>} { outcomes, unmatchedCandidateRefs, candidates, meta }
 */
async function groundSubmission(submission, jobLogger) {
  const submissionId = submission.id;
  const round = submission.currentRound || 1;
  const startTime = Date.now();

  // ── Step 1: inputs
  const authorRows = await loadAuthorKrtRows(submissionId, round);
  const { candidates, contributions } = await loadCandidatePool(submissionId, round);

  jobLogger?.log('inputs_loaded', 'Loaded author KRT rows and the candidate pool', {
    authorRowCount: authorRows.length,
    candidateCount: candidates.length,
    contributors: contributions.map((c) => `${c.source}:${c.items.length}`)
  });
  await jobLogger?.saveRawResponse('grounding-inputs', {
    authorRows, candidates, contributors: contributions.map((c) => ({ source: c.source, count: c.items.length }))
  });

  // ── Step 2: deterministic matching
  const matched = matchAuthorRows(authorRows, candidates);
  jobLogger?.log('deterministic_match', 'Matched author rows against candidates', matched.stats);

  // ── Step 3: LM second look over the rows nothing matched
  const notDetected = matched.outcomes.filter((o) => o.outcome === 'not_detected');
  let secondLookStats = { attempted: 0, recovered: 0, skipped: true, reason: 'no_rows' };

  if (notDetected.length > 0) {
    if (!groundingConfig.isConfigured() || !hasPrompt()) {
      secondLookStats = { attempted: 0, recovered: 0, skipped: true, reason: 'not_configured' };
      jobLogger?.log('second_look_skipped', 'Second look not configured — rows stay not_detected', {
        notDetectedCount: notDetected.length
      });
    } else {
      secondLookStats = await runSecondLook({
        submissionId, round, notDetected, jobLogger
      });
    }
  }

  const stats = recount(matched.outcomes, candidates.length, matched.unmatchedCandidateRefs.length);

  jobLogger?.log('grounding_done', 'Grounding complete', { ...stats, ...secondLookStats });

  const data = {
    outcomes: matched.outcomes,
    unmatchedCandidateRefs: matched.unmatchedCandidateRefs,
    candidates,
    meta: {
      ...stats,
      secondLook: secondLookStats,
      hasAuthorKrt: authorRows.length > 0,
      mode: authorRows.length > 0 ? 'with_krt' : 'no_krt',
      totalMs: Date.now() - startTime,
      model: groundingConfig.model
    }
  };

  await jobLogger?.saveRawResponse('grounding-outcomes', {
    meta: data.meta, outcomes: data.outcomes, unmatchedCandidateRefs: data.unmatchedCandidateRefs
  });

  return data;
}

/**
 * The author's KRT rows for this submission/round, in a shape the matcher can
 * consume. Returns [] when the submission has no KRT (Mode B) — the rest of the
 * pipeline is identical.
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object[]>}
 */
async function loadAuthorKrtRows(submissionId, round) {
  const { KRTData } = require('../../models');
  const rows = await KRTData.findAll({ where: { submissionId, round } });
  return rows.map((row) => ({
    id: row.id,
    resourceType: row.resourceType || '',
    resourceName: row.resourceName || '',
    identifier: row.identifier || '',
    source: row.source || '',
    newReuse: row.newReuse || '',
    additionalInformation: row.additionalInformation || ''
  }));
}

/**
 * Every detector's items, flattened into one pool. The pool INDEX is the `ref`
 * the outcomes refer to, so the order here is part of the contract — callers
 * persist the pool alongside the outcomes.
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<{ candidates: object[], contributions: object[] }>}
 */
async function loadCandidatePool(submissionId, round) {
  const { SubmissionJob } = require('../../models');
  const contributions = [];

  for (const { source, jobType } of CONTRIBUTOR_SOURCES) {
    const job = await SubmissionJob.getLatest(submissionId, jobType, round);
    const items = job?.result?.data?.items || [];
    if (items.length > 0) contributions.push({ source, items });
  }

  const candidates = contributions.flatMap(({ source, items }) =>
    items.map((item) => ({ ...item, detectedBy: source }))
  );

  return { candidates, contributions };
}

/**
 * Ask the LM to find the author rows the deterministic matcher missed.
 *
 * This is the *right* use of the author's table: as a search query. The model
 * gets the manuscript and a list of rows, and must return an exact quote for
 * each one it can locate. Every returned quote is re-verified against the
 * markdown here — a row is only upgraded out of `not_detected` when its quote
 * is genuinely present, so a confident-sounding hallucination changes nothing.
 *
 * Mutates the outcome objects in `notDetected` in place on success.
 *
 * @returns {Promise<object>} stats
 */
async function runSecondLook({ submissionId, round, notDetected, jobLogger }) {
  const markdownText = await loadMarkdown(submissionId, round);
  if (!markdownText) {
    return { attempted: 0, recovered: 0, skipped: true, reason: 'no_markdown' };
  }

  const index = buildEvidenceIndex(markdownText);
  const started = Date.now();
  let recovered = 0;
  let rejected = 0;

  for (let i = 0; i < notDetected.length; i += SECOND_LOOK_BATCH_SIZE) {
    const batch = notDetected.slice(i, i + SECOND_LOOK_BATCH_SIZE);
    let found;
    try {
      found = await askSecondLook(batch, markdownText);
    } catch (error) {
      // A failed second look must not fail the job: the deterministic verdict
      // (not_detected) is already correct, just less informed.
      logger.warn('KRT grounding second look failed for a batch', { submissionId, error: error.message });
      jobLogger?.log('second_look_error', 'Second look batch failed — rows stay not_detected', {
        batchStart: i, error: error.message
      });
      continue;
    }

    for (const hit of found) {
      const outcome = batch[hit.index];
      if (!outcome) continue;

      const located = locateQuote(index, hit.quote);
      if (!located) {
        rejected++;
        continue; // unverifiable quote — the row stays not_detected
      }

      outcome.outcome = 'confirmed';
      outcome.matchedBy = 'lm_second_look';
      outcome.evidence = {
        quote: String(hit.quote).trim(),
        offset: located.offset,
        section: located.section,
        match: located.match
      };
      outcome.reason = 'Not matched by any detector, but located in the manuscript by a targeted search.';
      recovered++;
    }
  }

  await jobLogger?.saveRawResponse('second-look', {
    attempted: notDetected.length, recovered, rejectedUnverifiableQuotes: rejected
  });

  return {
    attempted: notDetected.length,
    recovered,
    rejectedUnverifiableQuotes: rejected,
    skipped: false,
    durationMs: Date.now() - started
  };
}

/**
 * One batched LM call: "find these rows in this manuscript".
 * @param {object[]} batch - outcomes with outcome === 'not_detected'
 * @param {string} markdownText
 * @returns {Promise<{index:number, quote:string}[]>}
 */
async function askSecondLook(batch, markdownText) {
  const ai = new GoogleGenAI({ apiKey: groundingConfig.apiKey });
  const rows = batch.map((outcome, index) => ({
    index,
    resource_type: outcome.resourceType,
    resource_name: outcome.resourceName
  }));

  const prompt = `${getPrompt()}\n\nROWS TO FIND:\n${JSON.stringify(rows, null, 0)}\n\n---\n\nARTICLE MARKDOWN:\n\n${markdownText}`;

  const response = await generateContentWithRetry(ai, {
    model: groundingConfig.model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 }
    }
  }, { label: 'krt-grounding-second-look' });

  if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    logger.warn('Gemini response truncated (krt grounding second look)');
  }

  return parseSecondLookResponse(response.text);
}

/**
 * Parse the second-look response into verified-shape hits. Anything malformed
 * is dropped rather than guessed at.
 * @param {string} text
 * @returns {{index:number, quote:string}[]}
 */
function parseSecondLookResponse(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(sanitizeJsonEscapes(stripFences(text)));
    const found = Array.isArray(parsed) ? parsed : parsed.found;
    if (!Array.isArray(found)) return [];
    return found
      .filter((hit) => hit && Number.isInteger(hit.index) && typeof hit.quote === 'string' && hit.quote.trim())
      .map((hit) => ({ index: hit.index, quote: hit.quote }));
  } catch (error) {
    logger.error('Failed to parse KRT grounding second-look response', {
      error: error.message, preview: String(text).slice(0, 200)
    });
    return [];
  }
}

function stripFences(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  return fenced.length > 0 ? fenced[fenced.length - 1][1].trim() : String(text).trim();
}

/**
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<string|null>}
 */
async function loadMarkdown(submissionId, round) {
  const { File } = require('../../models');
  const mdFile = await File.findOne({
    where: { submissionId, type: FILE_TYPES.MARKDOWN, round },
    order: [['version', 'DESC']]
  });
  if (!mdFile) return null;
  const buffer = await s3Service.downloadFile(mdFile.s3Key);
  return buffer.toString('utf-8');
}

/** Recompute the outcome tallies after the second look has upgraded rows. */
function recount(outcomes, candidateCount, unmatchedCount) {
  const stats = {
    authorRows: outcomes.length,
    confirmed: 0,
    incomplete: 0,
    partial: 0,
    notDetected: 0,
    candidates: candidateCount,
    unmatchedCandidates: unmatchedCount
  };
  // Explicit per outcome: a catch-all `else` here would quietly report every
  // partial-name match as "not detected" in the job stats and the UI summary.
  for (const outcome of outcomes) {
    if (outcome.outcome === 'confirmed') stats.confirmed++;
    else if (outcome.outcome === 'incomplete') stats.incomplete++;
    else if (outcome.outcome === 'partial') stats.partial++;
    else stats.notDetected++;
  }
  return stats;
}

async function persistJobData(submissionId, jobType, round, data) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, jobType, round);
  if (job) {
    job.result = { ...(job.result || {}), data };
    job.changed('result', true);
    await job.save();
  }
}

/**
 * Read the persisted grounding result for a submission/round.
 * @param {string} submissionId
 * @param {number} [round]
 * @returns {Promise<object|null>}
 */
async function getGroundingResult(submissionId, round) {
  const { Submission, SubmissionJob } = require('../../models');
  if (!round) {
    const submission = await Submission.findByPk(submissionId, { attributes: ['id', 'currentRound'] });
    if (!submission) throw new NotFoundError('Submission');
    round = submission.currentRound || 1;
  }
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.KRT_GROUNDING, round);
  return job?.result?.data || null;
}

module.exports = {
  CONTRIBUTOR_SOURCES,
  SECOND_LOOK_BATCH_SIZE,
  queueKrtGrounding,
  processKrtGrounding,
  groundSubmission,
  getGroundingResult,
  // exported for tests
  parseSecondLookResponse,
  recount
};
