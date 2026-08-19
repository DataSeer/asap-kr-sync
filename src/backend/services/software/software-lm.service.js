/**
 * Software Detection — the LM pass.
 *
 * Runs ALONGSIDE Softcite, never instead of it.
 *
 * Softcite is a name-recogniser: it finds tool names written in prose, with
 * good precision. Measured against the DS curators' reports it recovered 25%
 * of software resources, and **253 of the 291 misses carried a machine-readable
 * identifier in the manuscript text** — 143 of them an `RRID:SCR_…`. Those are
 * invisible to a name recogniser by construction: they are identifiers, not
 * names. So are GitHub/PyPI/CRAN links, packages named only in a parenthetical,
 * and "custom scripts available at …" in a data-availability statement.
 *
 * This module reads the converted markdown and looks for exactly those,
 * cue-driven. Its output is unioned with Softcite's and deduped; where the two
 * agree, that agreement is a confidence signal rather than a duplicate.
 *
 * Detection is KRT-blind, like every other detector.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const softwareLmConfig = require('../../config/software-detection-lm-api');
const { ExternalServiceError } = require('../../utils/errors');
const { buildKrtItemsFromLM } = require('../pdf-analysis/lm-resource.service');
const { sanitizeJsonEscapes, salvageTruncatedObjects, extractJsonBlock } = require('../../utils/gemini-json');
const { generateContentWithRetry } = require('../../utils/gemini');
const logger = require('../../utils/logger');

const PROMPT_FILE = path.join(__dirname, '../../data/prompts/software-detection.txt');
let _promptCache = null;

// Matches the other detectors: gemini-2.5-flash allows 65536 output tokens and
// thinking is disabled, so the whole budget goes to output.
const MAX_OUTPUT_TOKENS = 65536;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

/**
 * Whether the LM pass should run at all.
 * @returns {boolean}
 */
function isEnabled() {
  return softwareLmConfig.isConfigured() && hasPrompt();
}

function getPrompt(override) {
  if (override != null && String(override).trim()) return String(override).trim();
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — restore it from git to enable the software LM pass`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded software detection prompt', { file: PROMPT_FILE, length: _promptCache.length });
  }
  return _promptCache;
}

/**
 * Run the LM pass over the manuscript markdown.
 * @param {string} markdownText
 * @param {{ prompt?: string }} [options]
 * @returns {Promise<{ resources: object[], rawResponse: string }>}
 */
async function detectSoftwareLM(markdownText, { prompt } = {}) {
  const ai = new GoogleGenAI({ apiKey: softwareLmConfig.apiKey });
  const fullPrompt = getPrompt(prompt) + '\n\n---\n\nARTICLE MARKDOWN:\n\n' + markdownText;
  const { sha256 } = require('../queue/run-inputs.service');
  const promptDigest = { sha256: sha256(fullPrompt), bytes: Buffer.byteLength(fullPrompt) };

  try {
    const response = await generateContentWithRetry(ai, {
      model: softwareLmConfig.model,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }, { label: 'software-lm' });

    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      logger.warn('Gemini response truncated (software LM) — output hit maxOutputTokens');
    }

    const text = response.text || '';
    return { resources: parseResponse(text), rawResponse: text, promptDigest };
  } catch (error) {
    logger.error('Gemini API call failed for software detection', { error: error.message });
    throw new ExternalServiceError('Gemini', error.message);
  }
}

/**
 * Parse the model's JSON, salvaging complete rows from a truncated body rather
 * than losing the whole response.
 * @param {string} text
 * @returns {object[]}
 */
function parseResponse(text) {
  if (!text) return [];
  const jsonStr = sanitizeJsonEscapes(extractJsonBlock(text));
  try {
    const parsed = JSON.parse(jsonStr);
    const resources = parsed.resources || parsed;
    if (!Array.isArray(resources)) {
      logger.warn('Software LM response is not an array', { type: typeof resources });
      return [];
    }
    logger.info('Parsed software from Gemini response', { count: resources.length });
    return resources;
  } catch (error) {
    logger.error('Failed to parse Gemini JSON response (software LM)', {
      error: error.message, preview: jsonStr.substring(0, 300)
    });
    const salvaged = salvageTruncatedObjects(jsonStr);
    if (salvaged.length > 0) {
      logger.warn('Salvaged rows from a truncated Gemini response (software LM)', { count: salvaged.length });
      return salvaged;
    }
    return [];
  }
}

/**
 * LM prompt-shape rows → canonical KrtEntry[].
 *
 * Pure function. `origin` is 'software-lm' so the consolidator can tell an LM
 * find from a Softcite one, and so the two collapse into one row carrying both
 * provenances rather than appearing twice.
 *
 * @param {object[]} rawItems
 * @returns {object[]} KrtEntry[]
 */
function buildKrtItemsSoftwareLM(rawItems) {
  return buildKrtItemsFromLM(rawItems, {
    origin: 'software-lm',
    defaultResourceType: 'Software/code',
    details: (r) => ({ version: String(r.version || '').trim() })
  });
}

module.exports = {
  // Exported so the caller can record which prompt a run used — the UI links
  // it, and a link derived from a lookup table is wrong the moment the file
  // moves.
  PROMPT_FILE,
  isEnabled,
  detectSoftwareLM,
  buildKrtItemsSoftwareLM,
  parseResponse
};
