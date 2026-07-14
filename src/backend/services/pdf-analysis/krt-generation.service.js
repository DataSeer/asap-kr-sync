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
const { computeDedupKey } = require('./identifier-normalize.service');
const logger = require('../../utils/logger');
const { generateContentWithRetry } = require('../../utils/gemini');
const { sanitizeJsonEscapes } = require('../../utils/gemini-json');

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

/**
 * Scrub internal candidate `ref` numbers out of an LM reason so the curator
 * never sees "merged refs 0 and 4" — the refs are an implementation detail.
 */
function cleanReason(reason) {
  if (!reason) return '';
  return String(reason)
    .replace(/\(?\s*\brefs?\b\s*#?\s*\d+(\s*(?:,|and|&|\/)\s*#?\s*\d+)*\s*\)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '')
    .trim();
}

/** Union the detectedBy provenance of several candidates (deduped by source). */
function unionDetectedBy(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    for (const d of (c.detectedBy || [])) {
      const key = d.source || '';
      if (!seen.has(key)) { seen.add(key); out.push(d); }
      else out.push(d); // keep all originalItems, even same source
    }
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
    const base = {
      resourceType: r.resourceType ?? refCandidates[0].resourceType ?? '',
      resourceName: r.resourceName ?? refCandidates[0].resourceName ?? '',
      sourceUrl: r.source ?? refCandidates[0].sourceUrl ?? '',
      identifier: r.identifier ?? refCandidates[0].identifier ?? '',
      newReuse: r.newReuse ?? refCandidates[0].newReuse ?? ''
    };
    items.push({
      ...base,
      dedupKey: computeDedupKey(base),
      detectedBy,
      confidence,
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
  candidates.forEach((c, n) => {
    if (used.has(n)) return;
    items.push({ ...c, reason: cleanReason(c.reason) || 'kept' });
  });

  return { items, dropped };
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
    // sanitizeJsonEscapes repairs unescaped backslashes in verbatim text
    // (LaTeX/units/paths), the same repair the detection modules apply.
    const parsed = JSON.parse(sanitizeJsonEscapes(extractJsonBlock(text)));
    return { resources: parsed.resources || [], dropped: parsed.dropped || [] };
  } catch (err) {
    logger.error('Failed to parse KRT generation JSON', { error: err.message });
    return { resources: [], dropped: [] };
  }
}

async function callGeminiForKrt(candidates) {
  const fs = require('fs');
  const path = require('path');
  const ai = new GoogleGenAI({ apiKey: krtGenConfig.apiKey });
  const prompt = fs.readFileSync(path.join(__dirname, '../../data/prompts/pdf-analysis-krt.txt'), 'utf-8').trim();
  const payload = { candidates: candidates.map((c, i) => candidateForPrompt(c, i)) };
  const fullPrompt = prompt + '\n\n---\n\nINPUT:\n\n' + JSON.stringify(payload, null, 2);
  const response = await generateContentWithRetry(ai, {
    model: krtGenConfig.model,
    contents: [{ role: 'user', parts: [{ text: fullPrompt }] }]
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
  return { lmOutput: parseLMResponse(response.text || ''), rawResponse: response.text || '' };
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
    const { lmOutput, rawResponse } = await callGeminiForKrt(candidates);
    const { items, dropped } = buildKrtFromLM(candidates, lmOutput);
    jobLogger?.log('krt_llm_done', 'LM consolidation complete', { kept: items.length, dropped: dropped.length });
    return { items, dropped, usedLM: true, rawResponse };
  } catch (err) {
    logger.error('KRT generation LM failed — falling back to rule-based merge', { error: err.message });
    jobLogger?.log('krt_llm_failed', 'LM consolidation failed; using rule-based merge', { error: err.message });
    return { items: candidates.map(c => ({ ...c, reason: 'kept (rule-based fallback)' })), dropped: [], usedLM: false };
  }
}

module.exports = {
  isConfigured,
  consolidateWithLM,
  // Pure helper (exported for tests)
  buildKrtFromLM
};
