/**
 * KRT Generation (PDF Analysis step b)
 *
 * After the detections are regrouped + coarsely deduplicated (mergeDetections),
 * an LM consolidates the candidates into the final Generated KRT — merging
 * near-duplicates, dropping non-resources, cleaning fields — and gives a reason
 * per line. LM-primary; callers fall back to the rule-based candidates when the
 * LM isn't configured, so the pipeline always yields a Generated KRT.
 */

const { GoogleGenAI } = require('@google/genai');
const krtGenConfig = require('../../config/krt-generation-api');
const { pickBestEvidence } = require('./evidence.service');
const { computeDedupKey } = require('./identifier-normalize.service');
const { mergeAdditionalInfo } = require('./merge-detections.service');
const logger = require('../../utils/logger');
const frozenParams = require('../../utils/frozen-params');
const { generateContentWithRetry } = require('../../utils/gemini');
const { sanitizeJsonEscapes, salvageTruncatedObjects, extractJsonBlock } = require('../../utils/gemini-json');
const { cleanReason } = require('../../utils/lm-reason');

function isConfigured() {
  return krtGenConfig.isConfigured();
}

/** Candidate (merged) → compact prompt shape with a ref + its detector sources. */
function candidateForPrompt(c, ref) {
  const sources = Array.isArray(c.detectedBy)
    ? [...new Set(c.detectedBy.map(d => d.source).filter(Boolean))]
    : [];
  return {
    ref,
    resourceType: c.resourceType || '',
    resourceName: c.resourceName || '',
    source: c.sourceUrl || '',
    identifier: c.identifier || '',
    newReuse: c.newReuse || '',
    sources
  };
}

/** Unique detection-module sources behind a candidate. */
function sourcesOf(c) {
  return Array.isArray(c?.detectedBy)
    ? [...new Set(c.detectedBy.map(d => d.source).filter(Boolean))]
    : [];
}

/** Union the detectedBy provenance of several candidates (every contributor, including repeats from one module). */
function unionDetectedBy(candidates) {
  // Every contributor is kept, including two from the same module: each carries
  // its own originalItem, and that is what the Generated KRT shows as the
  // working behind a merged row. (This used to keep a `seen` set that both
  // branches ignored, and a docstring promising a dedupe that never happened.)
  const out = [];
  for (const c of candidates) {
    for (const d of (c.detectedBy || [])) out.push(d);
  }
  return out;
}

/**
 * Map the LM consolidation output back onto the candidates → final Generated KRT
 * items (same shape mergeDetections emits, plus `reason`). Pure function.
 *
 * Safety: any candidate the LM neither placed in a resource nor dropped is kept
 * as its own row, so the LM can never silently lose detected data.
 *
 * @param {object[]} candidates - merged candidates (mergeDetections output)
 * @param {{ resources?: object[], dropped?: object[] }} lmOutput
 * @returns {{ items: object[], dropped: Array<{ ref:number, reason:string, resourceName:string }> }}
 */
function buildKrtFromLM(candidates, lmOutput) {
  const resources = Array.isArray(lmOutput?.resources) ? lmOutput.resources : [];
  const droppedIn = Array.isArray(lmOutput?.dropped) ? lmOutput.dropped : [];
  const used = new Set();
  const items = [];

  for (const r of resources) {
    const refs = (Array.isArray(r.refs) ? r.refs : [])
      .map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < candidates.length);
    if (refs.length === 0) continue;
    refs.forEach(n => used.add(n));
    const refCandidates = refs.map(n => candidates[n]);
    const detectedBy = unionDetectedBy(refCandidates);
    const confidence = Math.max(0, ...refCandidates.map(c => c.confidence || 0));
    // ADDITIONAL INFORMATION is a KRT column like any other, and `mergeDetections`
    // does real work to build it (each contributor's context, de-duplicated line
    // by line). Leaving it out of `base` dropped it from every item the LM placed
    // — while the safety-net path below kept it, so one output table carried two
    // different item shapes. Downstream, `makeAddSuggestion` reads it as the
    // suggestion's `context`, so its absence emptied that hint in the UI.
    const mergedInfo = refCandidates
      .map((c) => c.additionalInformation)
      .reduce((acc, info) => mergeAdditionalInfo(acc, info), '');

    const base = {
      resourceType: r.resourceType ?? refCandidates[0].resourceType ?? '',
      resourceName: r.resourceName ?? refCandidates[0].resourceName ?? '',
      sourceUrl: r.source ?? refCandidates[0].sourceUrl ?? '',
      identifier: r.identifier ?? refCandidates[0].identifier ?? '',
      newReuse: r.newReuse ?? refCandidates[0].newReuse ?? '',
      // ADDITIONAL INFORMATION is a KRT column like any other, and
      // mergeDetections does real work to build it (each contributor's context,
      // de-duplicated line by line). Leaving it out of `base` dropped it from
      // every item the LM placed, while the safety-net path below kept it — so
      // one output table carried two different item shapes. Downstream,
      // makeAddSuggestion reads it as the suggestion's `context`, so its
      // absence emptied that hint in the UI on every LM-placed row.
      //
      // The LM's own value wins when it supplied one; otherwise keep what the
      // detectors observed, merged line by line rather than concatenated, so a
      // blurb two detectors both recorded is not repeated.
      additionalInformation: r.additionalInformation ?? mergedInfo ?? ''
    };
    items.push({
      ...base,
      dedupKey: computeDedupKey(base),
      detectedBy,
      confidence,
      // The LM returns only the curated fields, so anything not named here is
      // lost. `evidence` was — which emptied the manuscript context out of every
      // suggestion, since suggestions are built from this table.
      evidence: pickBestEvidence(refCandidates.map(c => c.evidence)),
      reason: cleanReason(r.reason) || 'kept'
    });
  }

  const dropped = [];
  for (const d of droppedIn) {
    const ref = Number(d.ref);
    if (Number.isInteger(ref) && ref >= 0 && ref < candidates.length) {
      used.add(ref);
      const c = candidates[ref];
      dropped.push({
        ref,
        reason: cleanReason(d.reason) || 'dropped',
        resourceName: c.resourceName || '',
        resourceType: c.resourceType || '',
        identifier: c.identifier || '',
        sources: sourcesOf(c)
      });
    }
  }

  // Safety net: keep any candidate the LM forgot to place.
  //
  // `evidence` is normalised rather than merely spread: the LM-placed path
  // above always emits the key (possibly null), so a candidate that arrived
  // without one would produce a row missing a field its neighbours have — one
  // table with two shapes, which is the defect this file has already suffered
  // twice.
  candidates.forEach((c, n) => {
    if (used.has(n)) return;
    items.push({ evidence: null, ...c, reason: cleanReason(c.reason) || 'kept' });
  });

  return { items, dropped };
}

function parseLMResponse(text) {
  const block = extractJsonBlock(text);
  try {
    // sanitizeJsonEscapes repairs unescaped backslashes in verbatim text
    // (LaTeX/units/paths), the same repair the detection modules apply.
    const parsed = JSON.parse(sanitizeJsonEscapes(block));
    return { resources: parsed.resources || [], dropped: parsed.dropped || [] };
  } catch (err) {
    // Truncation is the common failure, and returning nothing here is worse
    // than it looks: `buildKrtFromLM` then places no resource, its safety net
    // keeps every candidate, and the Generated KRT silently ships UNCONSOLIDATED
    // — no dedup, no non-resource filtering — with only a log line to say so.
    // The four detection modules already salvage; this one did not.
    //
    // Both lists have to be recovered BY NAME. Salvaging the body as one flat
    // stream put the `dropped` entries — the candidates the model explicitly
    // rejected — into `resources`, where they shipped in the Generated KRT
    // labelled "kept", while the dropped-candidates table rendered empty.
    const resources = salvageTruncatedObjects(block, 'resources');
    const dropped = salvageTruncatedObjects(block, 'dropped');
    if (resources.length > 0 || dropped.length > 0) {
      logger.warn('KRT generation JSON was truncated — salvaged completed entries', {
        error: err.message, resources: resources.length, dropped: dropped.length
      });
      return { resources, dropped };
    }
    logger.error('Failed to parse KRT generation JSON', { error: err.message });
    return { resources: [], dropped: [] };
  }
}

/** The consolidation prompt, named once so a run can report which file it used. */
const PROMPT_FILE = require('path').join(__dirname, '../../data/prompts/pdf-analysis-krt.txt');

async function callGeminiForKrt(candidates) {
  const fs = require('fs');
  const ai = new GoogleGenAI({ apiKey: krtGenConfig.apiKey });
  // A frozen restart uses the run's own template — see materials.service getPrompt.
  const prompt = frozenParams.prompt(fs.readFileSync(PROMPT_FILE, 'utf-8').trim());
  const payload = { candidates: candidates.map((c, i) => candidateForPrompt(c, i)) };
  const fullPrompt = prompt + '\n\n---\n\nINPUT:\n\n' + JSON.stringify(payload, null, 2);
  const { sha256 } = require('../queue/run-inputs.service');
  const promptDigest = { sha256: sha256(fullPrompt), bytes: Buffer.byteLength(fullPrompt) };
  const response = await generateContentWithRetry(ai, {
    model: krtGenConfig.model,
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
    // This call had NO generation config at all, so it ran on the model default
    // token budget while every detection module asks for 65536. Consolidation
    // emits one line per candidate, so the biggest pools — precisely the ones
    // that most need deduplicating — truncated first. On a 335-row KRT the
    // response was cut mid-object, the parse failed, and the Generated KRT
    // silently shipped UNCONSOLIDATED via the safety net.
    //
    // thinkingBudget 0 for the same reason as the detectors: gemini-2.5-flash
    // thinks by default and that thinking comes out of the same budget.
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: 0 }
    }
  }, {
    label: 'krt-generation',
    // With candidates to consolidate, a healthy response parses to at least one
    // resource or drop; an empty/unparseable body means a broken response —
    // retry it. (On persistent failure the caller falls back to rule-based.)
    validate: (res) => {
      if (!candidates.length) return true;
      const { resources, dropped } = parseLMResponse(res?.text || '');
      return resources.length > 0 || dropped.length > 0;
    }
  });
  return { lmOutput: parseLMResponse(response.text || ''), rawResponse: response.text || '', promptDigest };
}

/**
 * Consolidate candidates into the Generated KRT. LM-primary; on a missing
 * config OR an LM failure, falls back to the candidates unchanged (rule-based).
 * @returns {Promise<{ items: object[], dropped: object[], usedLM: boolean, rawResponse?: string }>}
 */
async function consolidateWithLM(candidates, jobLogger = null) {
  if (!isConfigured() || candidates.length === 0) {
    return { items: candidates.map(c => ({ ...c, reason: 'kept (rule-based merge)' })), dropped: [], usedLM: false };
  }
  try {
    const { lmOutput, rawResponse, promptDigest } = await callGeminiForKrt(candidates);
    const { items, dropped } = buildKrtFromLM(candidates, lmOutput);
    jobLogger?.log('krt_llm_done', 'LM consolidation complete', { kept: items.length, dropped: dropped.length });
    return { items, dropped, usedLM: true, rawResponse, promptDigest };
  } catch (err) {
    logger.error('KRT generation LM failed — falling back to rule-based merge', { error: err.message });
    jobLogger?.log('krt_llm_failed', 'LM consolidation failed; using rule-based merge', { error: err.message });
    return { items: candidates.map(c => ({ ...c, reason: 'kept (rule-based fallback)' })), dropped: [], usedLM: false };
  }
}

module.exports = {
  PROMPT_FILE,
  // Exported so the audit verifier can rebuild this module's prompt through the
  // same shaping the pipeline uses. A reimplementation there would drift and
  // start passing for the wrong reason.
  candidateForPrompt,
  isConfigured,
  consolidateWithLM,
  // Pure helper (exported for tests)
  buildKrtFromLM
};
