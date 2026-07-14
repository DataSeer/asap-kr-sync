/**
 * KRT Comparison Service (LM-based suggestion generation)
 *
 * Replaces the on-read algorithmic diff: a dedicated Gemini call compares the
 * author's KRT against the tool-Generated KRT and returns add/update/remove
 * suggestions, prioritizing the author's data, keeping the list manageable, and
 * proposing removes only for clear mistakes.
 *
 * Runs as the SUGGESTION_GENERATION background job (after PDF_ANALYSIS) and is
 * re-triggerable. The result is persisted on the job as a list of canonical
 * suggestion objects (same shape the frontend already consumes), so the read
 * and approve/reject paths can use it directly without re-deriving anything.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const krtComparisonConfig = require('../../config/krt-comparison-api');
const jobQueue = require('../queue/job-queue.service');
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { computeDedupKey } = require('../pdf-analysis/identifier-normalize.service');
const logger = require('../../utils/logger');
const { generateContentWithRetry } = require('../../utils/gemini');
const { sanitizeJsonEscapes } = require('../../utils/gemini-json');

const PROMPT_FILE = path.join(__dirname, '../../data/prompts/krt-comparison.txt');
let _promptCache = null;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}
function getPrompt(override) {
  if (override != null && String(override).trim()) return String(override).trim();
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — this prompt is version-controlled; restore it from git to enable suggestion generation`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
  }
  return _promptCache;
}

// Author KRT fields exposed to the LM (and matched on the way back). Keep the
// camelCase keys the rest of the app uses.
const UPDATABLE_COLUMNS = ['resourceType', 'resourceName', 'source', 'identifier', 'newReuse'];
const COLUMN_LABEL = {
  resourceType: 'RESOURCE TYPE', resourceName: 'RESOURCE NAME', source: 'SOURCE',
  identifier: 'IDENTIFIER', newReuse: 'NEW/REUSE'
};

/** Shape an author KRTData row for the prompt payload (id is authoritative). */
function authorRowForPrompt(row) {
  return {
    id: row.id,
    resourceType: row.resourceType || '',
    resourceName: row.resourceName || '',
    source: row.source || '',
    identifier: row.identifier || '',
    newReuse: row.newReuse || ''
  };
}

/** Unique detection-module sources behind a Generated KRT item. */
function sourcesOf(g) {
  return Array.isArray(g?.detectedBy)
    ? [...new Set(g.detectedBy.map(d => d.source).filter(Boolean))]
    : [];
}
function primarySource(g) {
  return sourcesOf(g)[0] || null;
}

/**
 * Confidence tier for an `add` suggestion (issue #2). An add with a concrete
 * identifier is directly verifiable → `confident`. One without an identifier is
 * a "possible missing item" the curator should check before accepting →
 * `needs_verification`, so identifier-less finds are surfaced (per the goal:
 * find missing items with OR without identifiers) without being presented as
 * high-confidence. Deterministic — independent of anything the LM asserts.
 */
function addTier(g) {
  const hasIdentifier = !!(g.identifier && String(g.identifier).trim());
  if (hasIdentifier) return { tier: 'confident', tierReason: null };
  const hasSource = !!((g.sourceUrl || g.source) && String(g.sourceUrl || g.source).trim());
  return {
    tier: 'needs_verification',
    tierReason: hasSource
      ? 'No identifier found — a source/repository is given; confirm it and add the accession/RRID.'
      : 'No identifier or source found — verify this is a real, shareable resource before adding.'
  };
}

/** Shape a Generated KRT item for the prompt payload (ref + provenance). */
function generatedRowForPrompt(g, ref) {
  return {
    ref,
    resourceType: g.resourceType || '',
    resourceName: g.resourceName || '',
    source: g.sourceUrl || g.source || '',
    identifier: g.identifier || '',
    newReuse: g.newReuse || '',
    sources: sourcesOf(g)
  };
}

// KRT-row display shape attached to each decision so the UI can render the
// actual row (its columns) instead of a bare id/name.
function generatedRowDisplay(g) {
  if (!g) return null;
  return {
    resourceType: g.resourceType || '', resourceName: g.resourceName || '',
    source: g.sourceUrl || '', identifier: g.identifier || '', newReuse: g.newReuse || ''
  };
}
function authorRowDisplay(row) {
  return {
    resourceType: row.resourceType || '', resourceName: row.resourceName || '',
    source: row.source || '', identifier: row.identifier || '', newReuse: row.newReuse || ''
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * Strip raw KRT-row ids out of an LM reason — the affected row is now shown
 * directly in the UI, so "(row a3d12…)" / "row a3d12…" is just noise.
 */
function cleanReason(reason) {
  if (!reason) return '';
  return String(reason)
    .replace(/\(\s*(?:row\s+)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)/gi, '')
    .replace(/\brow\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'the matching author row')
    .replace(UUID_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

/**
 * Map the LM's per-resource decisions into (a) canonical suggestion objects the
 * frontend + approve/reject paths consume, carrying the real detection-module
 * origin via `mergedFrom` (request 2b), and (b) the full decision list (incl.
 * skips) with reasons for the module summary (request 2c). Pure function.
 *
 * @param {object[]} authorRows - KRTData rows (need id + current values)
 * @param {object[]} generatedKrt - Generated KRT items (carry dedupKey + detectedBy)
 * @param {object[]} lmDecisions - raw LM decisions [{ action, generatedRef?, authorRowId?, changes?, reason }]
 * @returns {{ suggestions: object[], decisions: object[] }}
 */
function buildSuggestionsFromLM(authorRows, generatedKrt, lmDecisions) {
  if (!Array.isArray(lmDecisions)) return { suggestions: [], decisions: [] };
  const byId = new Map((authorRows || []).map(r => [r.id, r]));
  const gen = Array.isArray(generatedKrt) ? generatedKrt : [];
  const genAt = (ref) => (Number.isInteger(ref) && ref >= 0 && ref < gen.length) ? gen[ref] : null;
  const suggestions = [];
  const decisions = [];
  const seen = new Set();

  for (const d of lmDecisions) {
    const action = String(d?.action || '').toLowerCase();
    const g = genAt(d.generatedRef);

    if (action === 'skip') {
      const skippedAuthor = byId.get(d.authorRowId);
      decisions.push({
        action: 'skip',
        resourceName: skippedAuthor?.resourceName || g?.resourceName || '',
        reason: cleanReason(d.reason), sources: sourcesOf(g),
        authorRow: skippedAuthor ? authorRowDisplay(skippedAuthor) : null,
        generatedRow: generatedRowDisplay(g)
      });
      continue;
    }

    if (action === 'add') {
      if (!g) continue;
      const dedupKey = g.dedupKey || computeDedupKey(g);
      const id = `add:${dedupKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      suggestions.push({
        id, type: 'add_row', action: 'add_row', status: 'pending',
        source: primarySource(g) || 'krt_comparison',
        title: g.resourceName || g.identifier || '(unnamed resource)',
        description: `Add ${g.resourceType || ''}: ${g.resourceName || g.identifier}`.trim(),
        reason: cleanReason(d.reason) || null,
        dedupKey, confidence: g.confidence || 0.8, existsInKRT: 'false', matchedKrtRowId: null,
        ...addTier(g), // issue #2: confident vs needs_verification (identifier-less)
        mergedFrom: g.detectedBy || [], // 2b: real detection-module origin
        data: {
          resourceType: g.resourceType || '', resourceName: g.resourceName || '',
          source: g.sourceUrl || '', identifier: g.identifier || '',
          newReuse: g.newReuse || '', additionalInformation: ''
        }
      });
      decisions.push({
        action: 'add', resourceName: g.resourceName || '', reason: cleanReason(d.reason),
        sources: sourcesOf(g), authorRow: null, generatedRow: generatedRowDisplay(g)
      });
      continue;
    }

    if (action === 'update') {
      const row = byId.get(d.authorRowId);
      if (!row) continue; // unknown row id → ignore (hallucination guard)
      const dedupKey = computeDedupKey(row);
      const changes = (d.changes && typeof d.changes === 'object') ? d.changes : {};
      const changeMap = {}; // column → { old, new } for the decision diff view
      for (const column of UPDATABLE_COLUMNS) {
        if (!(column in changes)) continue;
        const newValue = changes[column];
        if (newValue == null || String(newValue).trim() === '') continue;
        const oldValue = row[column] || '';
        if (String(oldValue).trim() === String(newValue).trim()) continue; // no-op
        const id = `edit:${dedupKey}:${column}`;
        if (seen.has(id)) continue;
        seen.add(id);
        changeMap[column] = { old: oldValue, new: String(newValue) };
        suggestions.push({
          id, type: 'edit', action: 'edit', status: 'pending',
          source: primarySource(g) || 'krt_comparison',
          title: `Update ${COLUMN_LABEL[column]} of ${row.resourceName || row.identifier || ''}`.trim(),
          description: `${COLUMN_LABEL[column]}: "${oldValue || '(empty)'}" → "${newValue}"`,
          reason: cleanReason(d.reason) || null,
          dedupKey, confidence: 0.8, existsInKRT: 'update', matchedKrtRowId: row.id,
          mergedFrom: g?.detectedBy || [], // 2b: origin of the filling value
          data: {
            rowId: row.id, column, columnLabel: COLUMN_LABEL[column],
            oldValue, newValue: String(newValue),
            resourceType: row.resourceType, resourceName: row.resourceName
          }
        });
      }
      if (Object.keys(changeMap).length > 0) {
        decisions.push({
          action: 'update', resourceName: row.resourceName || '', reason: cleanReason(d.reason),
          sources: sourcesOf(g),
          authorRow: authorRowDisplay(row), generatedRow: generatedRowDisplay(g), changes: changeMap
        });
      }
      continue;
    }

    if (action === 'remove') {
      const row = byId.get(d.authorRowId);
      if (!row) continue;
      const dedupKey = computeDedupKey(row);
      const id = `delete:${dedupKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      suggestions.push({
        id, type: 'delete_row', action: 'delete_row', status: 'pending', source: 'krt_comparison',
        title: row.resourceName || row.identifier || '(resource)',
        description: cleanReason(d.reason) || 'Remove likely-mistaken row',
        reason: cleanReason(d.reason) || null,
        dedupKey, confidence: 0.7, existsInKRT: 'delete', matchedKrtRowId: row.id,
        data: { rowId: row.id, resourceType: row.resourceType, resourceName: row.resourceName, newReuse: row.newReuse, identifier: row.identifier }
      });
      decisions.push({
        action: 'remove', resourceName: row.resourceName || '', reason: cleanReason(d.reason),
        sources: [], authorRow: authorRowDisplay(row), generatedRow: null
      });
      continue;
    }
  }

  // Flag any generated resource the LM never returned a decision for. The
  // prompt asks for exactly one decision per generated `ref`, but the model
  // sometimes forgets/omits some — those would otherwise vanish silently
  // (neither suggested nor skipped). We surface each as an `unreviewed`
  // decision (audit-only, NOT an actionable suggestion) so the curator can see
  // the resource wasn't evaluated and review it by hand.
  const decidedRefs = new Set();
  for (const d of lmDecisions) {
    const action = String(d?.action || '').toLowerCase();
    if ((action === 'add' || action === 'skip' || action === 'update') && Number.isInteger(d.generatedRef)) {
      decidedRefs.add(d.generatedRef);
    }
  }
  gen.forEach((g, ref) => {
    if (decidedRefs.has(ref)) return;
    decisions.push({
      action: 'unreviewed', resourceName: g.resourceName || '',
      reason: 'The AI did not return a decision for this detected resource — please review it manually.',
      sources: sourcesOf(g), authorRow: null, generatedRow: generatedRowDisplay(g)
    });
  });

  return { suggestions, decisions };
}

function extractJsonBlock(text) {
  if (typeof text !== 'string') return '';
  const fenced = [...text.matchAll(/```json\s*\n?([\s\S]*?)```/g)];
  if (fenced.length) return fenced[fenced.length - 1][1].trim();
  const plain = [...text.matchAll(/```\s*\n?([\s\S]*?)```/g)];
  if (plain.length) return plain[plain.length - 1][1].trim();
  return text.trim();
}

function parseLMResponse(text) {
  try {
    // sanitizeJsonEscapes repairs the common malformation where the model quotes
    // verbatim text (LaTeX/units/paths) with unescaped backslashes — the same
    // repair the detection modules already apply.
    const parsed = JSON.parse(sanitizeJsonEscapes(extractJsonBlock(text)));
    const list = parsed.decisions || parsed;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    logger.error('Failed to parse KRT comparison JSON', { error: err.message });
    return [];
  }
}

async function callGeminiForComparison(authorRows, generatedKrt, promptOverride) {
  const ai = new GoogleGenAI({ apiKey: krtComparisonConfig.apiKey });
  const prompt = getPrompt(promptOverride);
  const payload = {
    author_krt: authorRows.map(authorRowForPrompt),
    generated_krt: generatedKrt.map((g, i) => generatedRowForPrompt(g, i))
  };
  const fullPrompt = prompt + '\n\n---\n\nINPUT:\n\n' + JSON.stringify(payload, null, 2);

  try {
    const response = await generateContentWithRetry(ai, {
      model: krtComparisonConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }]
    }, {
      label: 'kr-comparison',
      // When there is something to compare, a healthy response parses to at
      // least one decision. An empty/unparseable body (0 decisions) means the
      // response was broken — retry it rather than silently dropping every
      // suggestion for this submission.
      validate: (res) => generatedKrt.length === 0 || parseLMResponse(res?.text || '').length > 0
    });
    const text = response.text || '';
    return { lmDecisions: parseLMResponse(text), rawResponse: text };
  } catch (error) {
    logger.error('Gemini API call failed for KRT comparison', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

/**
 * Compare an author KRT against a Generated KRT directly (no DB) — the LM call
 * plus the decision→suggestion mapping. Used by offline tooling/benchmarks that
 * already hold both row sets in memory.
 * @param {object[]} authorRows - author KRT rows (need id + values)
 * @param {object[]} generatedKrt - Generated KRT items (dedupKey + detectedBy)
 * @returns {Promise<{ suggestions: object[], decisions: object[], rawResponse: string }>}
 */
async function compareKrts(authorRows, generatedKrt) {
  const { lmDecisions, rawResponse } = await callGeminiForComparison(authorRows, generatedKrt);
  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, lmDecisions);
  return { suggestions, decisions, rawResponse };
}

/**
 * Generate suggestions for a submission/round (LM-only). Returns the helper
 * result shape persisted on the SubmissionJob: { data: { suggestions }, meta }.
 */
async function generateSuggestions(submissionId, round, jobLogger = null) {
  const { KRTData } = require('../../models');
  const { getGeneratedKrt } = require('../pdf-analysis/pdf-analysis.service');
  const startTime = Date.now();

  // LM-only: when the comparison API isn't configured we produce no
  // suggestions (no algorithmic fallback, by design).
  if (!krtComparisonConfig.isConfigured() || !hasPrompt()) {
    jobLogger?.log('suggestions_skipped', 'KRT comparison LM not configured — no suggestions generated');
    return { data: { suggestions: [] }, status: 'done', source: null, meta: { skipped: true, reason: 'lm_not_configured', totalMs: Date.now() - startTime } };
  }

  const [authorRows, generatedKrt] = await Promise.all([
    KRTData.findAll({ where: { submissionId, round } }),
    getGeneratedKrt(submissionId, round)
  ]);

  jobLogger?.log('comparison_start', 'Comparing author KRT vs Generated KRT', {
    authorCount: authorRows.length, generatedCount: generatedKrt.length
  });
  const { lmDecisions, rawResponse } = await callGeminiForComparison(authorRows, generatedKrt);
  await jobLogger?.saveRawResponse('krt-comparison', rawResponse || lmDecisions);

  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, lmDecisions);
  const unreviewedCount = decisions.filter(d => d.action === 'unreviewed').length;
  if (unreviewedCount) {
    logger.warn('KRT comparison left some generated resources unreviewed', {
      submissionId, round, unreviewedCount, generatedCount: generatedKrt.length
    });
  }
  jobLogger?.log('comparison_done', 'Suggestions generated', {
    decisionCount: decisions.length, suggestionCount: suggestions.length, unreviewedCount
  });

  return {
    data: { suggestions, decisions },
    status: 'done',
    source: 'external',
    meta: {
      authorCount: authorRows.length,
      generatedCount: generatedKrt.length,
      decisionCount: decisions.length,
      suggestionCount: suggestions.length,
      unreviewedCount,
      totalMs: Date.now() - startTime,
      model: krtComparisonConfig.model
    }
  };
}

/** Queue (or re-queue) suggestion generation as a background job. */
async function queueSuggestionGeneration(submissionId, round = 1) {
  const { SubmissionJob } = require('../../models');
  const orchestrator = require('../queue/orchestrator.service');
  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round);

  const submissionJob = await SubmissionJob.create({
    submissionId, jobType: JOB_TYPES.SUGGESTION_GENERATION, status: 'queued', round
  });
  const jobId = await jobQueue.addJob(
    jobQueue.QUEUES.SUGGESTION_GENERATION,
    { submissionId, submissionJobId: submissionJob.id }
  );
  submissionJob.pgBossJobId = jobId;
  await submissionJob.save();
  logger.info('Suggestion generation queued', { submissionId, submissionJobId: submissionJob.id, jobId });
  return jobId;
}

/** Worker entry point. Persists the suggestion list on the SubmissionJob. */
async function processSuggestionGeneration(submissionId, jobLogger = null /*, opts */) {
  const { Submission, SubmissionJob } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  if (!submission) throw new NotFoundError('Submission');
  const round = submission.currentRound || 1;

  const result = await generateSuggestions(submissionId, round, jobLogger);

  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round);
  if (job) {
    job.result = { ...(job.result || {}), data: result.data, meta: result.meta };
    job.changed('result', true);
    await job.save();
  }
  return result;
}

/** Read the persisted suggestion list (canonical shape) for a submission/round. */
async function getPersistedSuggestions(submissionId, round) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round);
  return job?.result?.data?.suggestions || [];
}

module.exports = {
  queueSuggestionGeneration,
  processSuggestionGeneration,
  generateSuggestions,
  getPersistedSuggestions,
  compareKrts,
  // Pure helpers (exported for tests)
  buildSuggestionsFromLM
};
