/**
 * DAS Extraction Service (Google Gemini)
 *
 * Takes the converted manuscript markdown and asks Gemini to copy the
 * Data Availability Statement (or whatever `section` is configured) out
 * of it verbatim. Returns the structured response:
 *   { content, partialMatch, sectionFragmented }
 * or `null` when the service is disabled.
 *
 * Replaces the previous Modal-hosted llama fine-tune
 * (pdf-das-extractor-client.service.js). The prompt lives in
 * src/backend/data/prompts/das-extraction.txt (public, version-controlled).
 *
 * No PDF handling here — by the time DAS extraction runs the Markdown
 * Convert job has already produced a markdown File on S3, and the caller
 * (pdf.service.js::runDasExtractor) downloads it and passes the text in.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const dasConfig = require('../../config/das-extraction-api');
const { ExternalServiceError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { generateContentWithRetry } = require('../../utils/gemini');

const PROMPT_FILE = path.join(__dirname, '../../data/prompts/das-extraction.txt');
let _promptCache = null;

function hasPrompt() {
  return fs.existsSync(PROMPT_FILE);
}

/**
 * Resolve the extraction prompt. An explicit `override` (non-empty string) wins
 * — used by tuning/experiment scripts; otherwise the committed default file is
 * read once and cached.
 * @param {string} [override] - optional prompt text to use instead of the file
 * @returns {string}
 */
function getPrompt(override) {
  if (override != null && String(override).trim()) {
    return String(override).trim();
  }
  if (!_promptCache) {
    if (!hasPrompt()) {
      throw new Error(`Prompt file not found: ${PROMPT_FILE} — this prompt is version-controlled; restore it from git to enable DAS extraction`);
    }
    _promptCache = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
    logger.info('Loaded DAS extraction prompt', { file: PROMPT_FILE, length: _promptCache.length });
  }
  return _promptCache;
}

/**
 * Parse Gemini's response into the structured shape the rest of the
 * pipeline expects. Tolerates fenced code-blocks (```json ... ```) and
 * snake_case keys (per the prompt) — normalises to camelCase here.
 *
 * Returns { content: '', partialMatch: false, sectionFragmented: false }
 * when the response can't be parsed; the caller logs and treats empty
 * content as "section not found".
 */
function parseGeminiResponse(text) {
  if (!text || typeof text !== 'string') {
    return { content: '', partialMatch: false, sectionFragmented: false };
  }
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      content: typeof parsed.content === 'string' ? parsed.content : '',
      partialMatch: !!parsed.partial_match,
      sectionFragmented: !!parsed.section_fragmented
    };
  } catch (error) {
    logger.warn('Failed to parse Gemini JSON response (DAS extraction)', {
      error: error.message,
      preview: jsonStr.substring(0, 300)
    });
    return { content: '', partialMatch: false, sectionFragmented: false };
  }
}

/**
 * Extract the configured section (default `das`) from a manuscript's
 * markdown.
 *
 * @param {string} markdownText - Full markdown of the manuscript
 * @param {{ prompt?: string }} [options] - `prompt` overrides the default
 *   extraction prompt (defaults to the committed prompt file content).
 * @returns {Promise<null | { content, partialMatch, sectionFragmented, raw }>}
 *   null when the service is disabled / unconfigured.
 *   Otherwise the parsed Gemini response; `raw` is the full text Gemini
 *   returned (kept for forensics / saveRawResponse).
 */
async function extractDAS(markdownText, { prompt } = {}) {
  if (!dasConfig.isConfigured()) {
    logger.warn('DAS Extraction not configured, skipping');
    return null;
  }
  if (!markdownText || typeof markdownText !== 'string' || !markdownText.trim()) {
    logger.warn('DAS Extraction received empty markdown — returning empty result');
    return { content: '', partialMatch: false, sectionFragmented: false, raw: '' };
  }

  const ai = new GoogleGenAI({ apiKey: dasConfig.apiKey });
  const resolvedPrompt = getPrompt(prompt);
  const fullPrompt = `${resolvedPrompt}\n\nSection type: ${dasConfig.section}\n\nMANUSCRIPT:\n${markdownText}`;

  try {
    const response = await generateContentWithRetry(ai, {
      model: dasConfig.model,
      contents: [
        { role: 'user', parts: [{ text: fullPrompt }] }
      ]
    }, { label: 'das-extraction' });

    const text = response.text;
    if (!text) {
      logger.warn('Gemini returned empty response for DAS extraction');
      return { content: '', partialMatch: false, sectionFragmented: false, raw: '' };
    }

    logger.debug('Gemini raw response preview (DAS)', { preview: text.substring(0, 500) });
    const parsed = parseGeminiResponse(text);
    logger.info('DAS extraction completed', {
      section: dasConfig.section,
      model: dasConfig.model,
      hasContent: !!parsed.content,
      length: parsed.content.length,
      partialMatch: parsed.partialMatch,
      sectionFragmented: parsed.sectionFragmented
    });
    return { ...parsed, raw: text };
  } catch (error) {
    logger.error('Gemini API call failed for DAS extraction', { error: error.message });
    throw new ExternalServiceError('DAS Extraction (Gemini)', error.message);
  }
}

module.exports = {
  extractDAS,
  hasPrompt,
  // Exposed for tests
  parseGeminiResponse
};
