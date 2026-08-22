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
const { JOB_TYPES } = require('../../config/constants');
const { NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { computeDedupKey } = require('../pdf-analysis/identifier-normalize.service');
const logger = require('../../utils/logger');
const { getPipeline } = require('../../config/pipelines');
const { generateContentWithRetry } = require('../../utils/gemini');
const { sanitizeJsonEscapes, salvageTruncatedObjects, extractJsonBlock } = require('../../utils/gemini-json');
const { cleanReason } = require('../../utils/lm-reason');
const { repoPath } = require('../detection/repo-path');
const runInputs = require('../queue/run-inputs.service');

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

/**
 * Turn `incomplete` grounding outcomes into edit suggestions.
 *
 * These are the highest-trust updates the pipeline can make: a candidate that
 * matched this row by identifier/alias/name actually carried the value, and the
 * author's cell is empty. Nothing is written — this only proposes.
 *
 * `not_detected` outcomes deliberately produce NO suggestion. "The manuscript
 * never mentions this" is not an action to take on the author's table; it is a
 * tag, surfaced separately via `groundings` so the editor can badge the row.
 * The author's data is right even when we cannot find it.
 *
 * @param {object} ctx - { groundingOutcomes, byId, suggestions, decisions, seen }
 */
function appendGroundingUpdates({ groundingOutcomes, byId, suggestions, decisions, seen }) {
  for (const outcome of Array.isArray(groundingOutcomes) ? groundingOutcomes : []) {
    if (outcome?.outcome !== 'incomplete') continue;
    const row = byId.get(outcome.krtRowId);
    if (!row) continue;

    const dedupKey = computeDedupKey(row);
    const changeMap = {};

    for (const column of UPDATABLE_COLUMNS) {
      const newValue = outcome.foundValues?.[column];
      if (newValue == null || String(newValue).trim() === '') continue;
      const oldValue = row[column] || '';
      // Grounding only ever proposes for an EMPTY author cell; this re-checks
      // that here so a stale outcome can never overwrite curated data.
      if (String(oldValue).trim() !== '') continue;

      const id = `edit:${dedupKey}:${column}`;
      if (seen.has(id)) continue;
      seen.add(id);
      changeMap[column] = { old: oldValue, new: String(newValue) };

      suggestions.push({
        id, type: 'edit', action: 'edit', status: 'pending',
        source: 'krt_grounding',
        title: `Update ${COLUMN_LABEL[column]} of ${row.resourceName || row.identifier || ''}`.trim(),
        description: `${COLUMN_LABEL[column]}: "${oldValue || '(empty)'}" → "${newValue}"`,
        reason: outcome.reason || null,
        dedupKey, confidence: 0.9, existsInKRT: 'update', matchedKrtRowId: row.id,
        mergedFrom: ['krt_grounding'],
        evidence: outcome.evidence || null,
        data: {
          rowId: row.id, column, columnLabel: COLUMN_LABEL[column],
          oldValue, newValue: String(newValue),
          resourceType: row.resourceType, resourceName: row.resourceName
        }
      });
    }

    if (Object.keys(changeMap).length > 0) {
      decisions.push({
        action: 'update', resourceName: row.resourceName || '',
        reason: outcome.reason, sources: ['krt_grounding'],
        authorRow: authorRowDisplay(row), generatedRow: null, changes: changeMap
      });
    }
  }
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
 * @param {object[]} [groundingOutcomes] - per-author-row verdicts from krt_grounding
 * @returns {{ suggestions: object[], decisions: object[] }}
 */
function buildSuggestionsFromLM(authorRows, generatedKrt, lmDecisions, groundingOutcomes = []) {
  if (!Array.isArray(lmDecisions)) return { suggestions: [], decisions: [] };
  const byId = new Map((authorRows || []).map(r => [r.id, r]));
  const gen = Array.isArray(generatedKrt) ? generatedKrt : [];
  const genAt = (ref) => (Number.isInteger(ref) && ref >= 0 && ref < gen.length) ? gen[ref] : null;
  const suggestions = [];
  const decisions = [];
  const seen = new Set();

  // Grounding-derived fills go FIRST. They are deterministic (a real candidate
  // carried the value, matched by identifier/alias/name) so they should win the
  // `seen` race against an LM proposal for the same row+column, which is then
  // skipped by the existing dedupe rather than duplicated.
  appendGroundingUpdates({ groundingOutcomes, byId, suggestions, decisions, seen });

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
        // Where in the manuscript this came from: the quote, its section, and
        // the surrounding paragraph with offsets so the UI can show a sentence
        // collapsed and the paragraph expanded. Lets a curator judge an `add`
        // without opening the PDF.
        evidence: g.evidence || null,
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

function parseLMResponse(text) {
  const block = extractJsonBlock(text);
  try {
    // sanitizeJsonEscapes repairs the common malformation where the model quotes
    // verbatim text (LaTeX/units/paths) with unescaped backslashes — the same
    // repair the detection modules already apply.
    const parsed = JSON.parse(sanitizeJsonEscapes(block));
    const list = parsed.decisions || parsed;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    // Returning [] here costs the user EVERY suggestion for the manuscript:
    // the panel comes back empty with nothing to say anything went wrong. On a
    // 335-row KRT this fired four times in a row and produced zero suggestions
    // after 22 minutes of retries. Recover the decisions that completed before
    // the response was cut, as the detection modules already do.
    const salvaged = salvageTruncatedObjects(block).filter((d) => d && typeof d === 'object');
    if (salvaged.length > 0) {
      logger.warn('KRT comparison JSON was truncated — salvaged completed decisions', {
        error: err.message, salvaged: salvaged.length
      });
      return salvaged;
    }
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
  const promptDigest = { sha256: runInputs.sha256(fullPrompt), bytes: Buffer.byteLength(fullPrompt) };

  try {
    const response = await generateContentWithRetry(ai, {
      model: krtComparisonConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      // This call had NO generation config at all, so it ran on the model's
      // default token budget while the prompt demands one decision per
      // generated row and shouts "COMPLETENESS IS MANDATORY" — a paragraph that
      // exists precisely because the response was being truncated.
      //
      // The biggest tables, whose curators most need the help, truncated first:
      // the parse failed and the user got an EMPTY suggestions panel with
      // nothing to say anything had gone wrong.
      //
      //   - responseMimeType → complete, valid JSON instead of fenced prose
      //   - maxOutputTokens  → headroom for a long decision list
      //   - thinkingBudget 0 → gemini-2.5-flash thinks by default, and that
      //                        thinking comes out of the same budget
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, {
      label: 'kr-comparison',
      // When there is something to compare, a healthy response parses to at
      // least one decision. An empty/unparseable body (0 decisions) means the
      // response was broken — retry it rather than silently dropping every
      // suggestion for this submission.
      validate: (res) => generatedKrt.length === 0 || parseLMResponse(res?.text || '').length > 0
    });
    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      // Surfaced explicitly: a truncated body silently loses decisions, and the
      // `unreviewed` safety net downstream would otherwise be the only clue.
      logger.warn('Gemini response truncated (kr-comparison) — output hit maxOutputTokens', {
        generatedCount: generatedKrt.length
      });
    }
    const text = response.text || '';
    return { lmDecisions: parseLMResponse(text), rawResponse: text, promptDigest };
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

  const { getGroundingResult } = require('../krt-grounding/krt-grounding.service');
  const [authorRows, generatedKrt, grounding] = await Promise.all([
    KRTData.findAll({ where: { submissionId, round } }),
    getGeneratedKrt(submissionId, round),
    getGroundingResult(submissionId, round)
  ]);
  const groundingOutcomes = grounding?.outcomes || [];

  jobLogger?.log('comparison_start', 'Comparing author KRT vs Generated KRT', {
    authorCount: authorRows.length, generatedCount: generatedKrt.length,
    groundedRowCount: groundingOutcomes.length
  });
  const { lmDecisions, rawResponse, promptDigest } = await callGeminiForComparison(authorRows, generatedKrt);
  await jobLogger?.saveRawResponse('krt-comparison', rawResponse || lmDecisions);
  // Both tables as this run saw them: the author's is edited constantly, and the
  // Generated one is replaced by any re-run of consolidation.
  await runInputs.saveRunInputs(jobLogger, {
    frozen: { authorRows, generatedKrt, groundingOutcomes },
    prompt: runInputs.promptRef(repoPath(PROMPT_FILE), promptDigest || null),
    meta: {
      model: krtComparisonConfig.model,
      authorCount: authorRows.length,
      generatedCount: generatedKrt.length,
      groundedRowCount: groundingOutcomes.length
    },
    // Everything asked of the external service, sanitised: secrets redacted,
    // anything large replaced by its digest. Recorded whole rather than
    // hand-picked — a hand-picked list is one somebody has to remember to
    // extend, which is how four modules came to record no model at all.
    call: krtComparisonConfig
  });

  const { suggestions, decisions } = buildSuggestionsFromLM(authorRows, generatedKrt, lmDecisions, groundingOutcomes);
  const unreviewedCount = decisions.filter(d => d.action === 'unreviewed').length;
  if (unreviewedCount) {
    logger.warn('KRT comparison left some generated resources unreviewed', {
      submissionId, round, unreviewedCount, generatedCount: generatedKrt.length
    });
  }
  jobLogger?.log('comparison_done', 'Suggestions generated', {
    decisionCount: decisions.length, suggestionCount: suggestions.length, unreviewedCount
  });

  // `groundings` is a per-author-row TAG list, not an action list: the editor
  // badges a row that the manuscript never mentions. It deliberately carries no
  // suggestion — the author's KRT is authoritative even when detection cannot
  // corroborate it, so there is nothing here for the user to accept or reject.
  // Which halves of grounding this pipeline is allowed to show.
  //
  // `presence` — the manuscript searched directly for the row — travels in
  // every pipeline: it never consults the candidate pool, so seeding cannot
  // affect it.
  //
  // Everything derived from candidate MATCHING is withheld under a seeded
  // pipeline. There the pool contains the model's echo of the author's own
  // rows, so `confirmed` can mean "it repeated what we handed it" and the
  // output cannot tell that from a real find. Withholding it here rather than
  // hiding it in the editor means the unusable verdict never leaves the server.
  const { Submission } = require('../../models');
  const submission = await Submission.findByPk(submissionId);
  const policy = getPipeline(submission?.pipelineId).grounding;

  const groundings = groundingOutcomes.map((outcome) => ({
    krtRowId: outcome.krtRowId,
    // Honest in every pipeline.
    presence: outcome.presence || null,
    identifier: outcome.identifier || '',
    source: outcome.source || '',
    newReuse: outcome.newReuse || '',
    // Conflicts drive the "Incoherence" verdict, so they travel in every
    // pipeline — a disagreement between the author's row and the manuscript is
    // worth surfacing even when candidate MATCHING is not.
    conflicts: outcome.conflicts || [],
    ...(policy.surfaceValues ? {
      outcome: outcome.outcome,
      matchedBy: outcome.matchedBy || null,
      evidence: outcome.evidence || null,
      // Disagreements between the row and the manuscript. Carried as a TAG, not
      // a suggestion: the author's value stands and a curator decides.
      conflicts: outcome.conflicts || [],
      reason: outcome.reason || null
    } : {})
  }));
  // Counted from PRESENCE, not from the matcher: "not in the text" is a claim
  // about the manuscript, and matching through candidates gets it wrong roughly
  // three times out of four (55-60% located against 92% by direct search).
  const notDetectedCount = groundings.filter((g) => g.presence && !g.presence.found).length;
  const conflictCount = groundings.reduce((n, g) => n + (g.conflicts?.length || 0), 0);

  return {
    data: { suggestions, decisions, groundings, groundingPolicy: policy },
    status: 'done',
    source: 'external',
    meta: {
      authorCount: authorRows.length,
      generatedCount: generatedKrt.length,
      decisionCount: decisions.length,
      suggestionCount: suggestions.length,
      unreviewedCount,
      groundedRowCount: groundings.length,
      notDetectedCount,
      conflictCount,
      totalMs: Date.now() - startTime,
      model: krtComparisonConfig.model,
      promptFile: repoPath(PROMPT_FILE)
    }
  };
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
async function queueSuggestionGeneration(submissionId, round = 1, userId = null) {
  const orchestrator = require('../queue/orchestrator.service');
  const { SubmissionJob } = require('../../models');

  // Read BEFORE re-queueing. `requeueStep` leaves a re-run at `queued`, so the
  // row it returns cannot tell a caller whether it started this run or found
  // one already going.
  const before = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round);
  const alreadyInFlight = ['queued', 'processing'].includes(before?.status);

  await orchestrator.cascadeRestart(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round, userId);
  const job = await orchestrator.requeueStep(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round, userId);

  logger.info('Suggestion generation re-queued', {
    submissionId, round, submissionJobId: job.id, status: job.status, alreadyInFlight
  });
  return { job, alreadyInFlight };
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
    // meta goes INSIDE data, which is where every other module puts it and
    // where the UI reads it from.
    await job.persistData({ ...result.data, meta: result.meta });
  }
  return result;
}

/** Read the persisted suggestion list (canonical shape) for a submission/round. */
async function getPersistedSuggestions(submissionId, round) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round);
  return job?.result?.data?.suggestions || [];
}

/**
 * The per-author-row grounding tags persisted alongside the suggestions.
 *
 * Separate from the suggestion list on purpose: these are verdicts ABOUT the
 * author's rows, not proposals to change them, so they must never enter the
 * accept/reject flow.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object[]>}
 */
async function getPersistedGroundings(submissionId, round) {
  const { SubmissionJob } = require('../../models');
  const job = await SubmissionJob.getLatest(submissionId, JOB_TYPES.SUGGESTION_GENERATION, round);
  return job?.result?.data?.groundings || [];
}

module.exports = {
  // Exported for the audit verifier: it rebuilds this prompt through the same
  // shaping the pipeline uses, rather than a copy that could drift.
  authorRowForPrompt,
  generatedRowForPrompt,
  queueSuggestionGeneration,
  processSuggestionGeneration,
  generateSuggestions,
  getPersistedSuggestions,
  getPersistedGroundings,
  compareKrts,
  // Exported so an offline harness can reproduce the REAL suggestion path —
  // buildSuggestionsFromLM WITH grounding outcomes. compareKrts alone omits the
  // grounding-derived updates, which would under-report what the pipeline does.
  callGeminiForComparison,
  // Pure helpers (exported for tests)
  buildSuggestionsFromLM
};
