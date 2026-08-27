/**
 * Helpers for parsing JSON returned by Gemini.
 *
 * LLMs frequently quote verbatim source text (methods sections, file paths,
 * LaTeX/units like \mu, \upmu, \times) inside JSON string values without escaping
 * the backslash, producing invalid JSON that throws "Bad escaped character".
 * Even responseMimeType:'application/json' doesn't fully prevent this.
 */

// Valid JSON escapes are \" \\ \/ \b \f \n \r \t and \uXXXX (4 hex digits).
// Match a full valid escape OR a lone backslash; doubling only the lone ones.
// Consuming valid escapes whole is essential — a left-to-right scan must not
// mistake the second backslash of a valid \\ pair for a stray backslash.
const ESCAPE_OR_BACKSLASH = /\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g;

/**
 * Make model-produced JSON parseable by escaping stray backslashes, so verbatim
 * text containing LaTeX/units/paths (\mu, \upmu, C:\Users) doesn't throw
 * "Bad escaped character". Valid escapes (\n, \t, \\, \uXXXX) are preserved.
 * @param {string} str
 * @returns {string}
 */
function sanitizeJsonEscapes(str) {
  return String(str).replace(ESCAPE_OR_BACKSLASH, (match, validEscape) =>
    validEscape !== undefined ? match : '\\\\');
}

/**
 * Recover the complete objects from a truncated JSON array response.
 *
 * When a response hits `maxOutputTokens` the body ends mid-object, `JSON.parse`
 * throws, and the caller returns [] — so a run that had already produced 80
 * usable rows yields nothing. Observed in production: a 133 KB manuscript
 * returned 87 materials, hit the cap on the 87th, and the module recorded 0.
 *
 * Raising the cap makes that rarer; this makes it non-fatal. We scan the text
 * for balanced objects (tracking string state so a brace inside a quoted value
 * doesn't confuse the depth count) and keep every object that closed cleanly,
 * discarding the partial tail.
 *
 * **Objects are attributed to the array they came from**, which is the whole
 * reason this is a scanner and not a regex. An envelope can carry more than one
 * list — `{"resources": [...], "dropped": [...]}` — and they mean opposite
 * things: `dropped` is the candidates the model REJECTED. Collecting both into
 * one flat list put rejected candidates into the Generated KRT labelled "kept",
 * and left the dropped-candidates audit table empty.
 *
 * With no `key`, only the first array's elements are returned — for a bare
 * `[{…},{…}]` stream that is the whole body. Pass a `key` to take a named
 * array instead; an absent key yields [] rather than silently falling back to
 * another list.
 *
 * @param {string} text - the (possibly truncated) JSON body
 * @param {string} [key] - property name of the array to recover
 * @returns {object[]} the objects that were complete, [] if none
 */
function salvageTruncatedObjects(text, key) {
  const str = String(text || '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let stringStart = -1;

  // Rows live inside an array, which itself usually sits inside an envelope
  // object (`{"resources": [ … ]`). That envelope's opening brace means array
  // elements open and close at depth 1, not 0 — so anchor on the depth at which
  // the array was entered. With a bare `{…},{…}` stream (no array) this stays 0
  // and behaves the same way.
  let elementDepth = 0;
  let arrayDepth = -1;      // depth at which the array we are inside was opened
  let arrayIndex = -1;      // which array of the envelope this is
  let currentKey = null;    // the property name that array is the value of
  let lastString = null;    // candidate key: the most recent string literal
  let firstArrayKey;        // the key of array 0, resolved once

  const wanted = () => (key === undefined ? arrayIndex === 0 : currentKey === key);

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        lastString = str.slice(stringStart + 1, i);
      }
      continue;
    }

    if (ch === '"') { inString = true; stringStart = i; continue; }

    // `"resources":` — the string before a colon names whatever follows it.
    if (ch === ':') continue;

    if (ch === '[' && arrayDepth === -1) {
      // Entering a rows array. Anything open before it is the envelope, not a
      // row, so abandon that candidate and re-anchor here.
      arrayDepth = depth;
      elementDepth = depth;
      arrayIndex++;
      currentKey = lastString;
      if (arrayIndex === 0) firstArrayKey = currentKey;
      start = -1;
      continue;
    }

    if (ch === ']' && depth === arrayDepth) {
      // The array closed cleanly — a later array is a different list. (A
      // truncated body never gets here, which is the case that matters.)
      arrayDepth = -1;
      currentKey = null;
      start = -1;
      continue;
    }

    if (ch === '{') {
      if (depth === elementDepth) start = i;
      depth++;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (depth === elementDepth && start >= 0) {
        const candidate = str.slice(start, i + 1);
        if (wanted()) {
          try {
            objects.push(JSON.parse(sanitizeJsonEscapes(candidate)));
          } catch {
            // A malformed complete-looking object is skipped, not fatal.
          }
        }
        start = -1;
      }
      if (depth < elementDepth) depth = elementDepth; // stray closer — resynchronise
    }
  }

  // A bare `{…},{…}` stream never enters an array, so nothing was attributed.
  // Re-read it as array 0 rather than returning nothing.
  if (key === undefined && arrayIndex === -1 && firstArrayKey === undefined && objects.length === 0) {
    return salvageObjectStream(str);
  }

  return objects;
}

/** The no-array case: a bare stream of sibling objects at depth 0. */
function salvageObjectStream(str) {
  const objects = [];
  let depth = 0, start = -1, inString = false, escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(sanitizeJsonEscapes(str.slice(start, i + 1)))); } catch { /* skip */ }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return objects;
}


/**
 * Pull the JSON out of a model response that may have wrapped it in a fence.
 *
 * There were five copies of this across the detectors, in three behaviours, and
 * the differences were bugs rather than intent:
 *
 *   - two (`stripFences` in krt-grounding and software-lm) stopped at the last
 *     CLOSED fence, so a response truncated at the token limit — which never
 *     gets its closing fence — fell through to `String(text).trim()` and handed
 *     JSON.parse a leading "```json". Every partial result was thrown away at
 *     the very moment the salvage path existed to rescue it.
 *   - one (das-suggestions) had the same gap.
 *   - one (`stripMarkdownFences` in datasets) only stripped when the response
 *     STARTED with a fence, so a model that prefixed one polite line
 *     ("Here is the JSON:") defeated it completely.
 *
 * The full behaviour, from krt-generation and kr-comparison, is the one kept:
 * prefer the last ```json block, then the last plain ``` block, then — for an
 * unterminated fence — everything after the opener, so `salvageTruncatedObjects`
 * can recover whatever completed before the cut. Unfenced text is returned
 * as-is.
 *
 * @param {string} text - raw model response
 * @returns {string} the JSON body, or '' for a non-string
 */
function extractJsonBlock(text) {
  if (typeof text !== 'string') return '';
  const fenced = [...text.matchAll(/```json\s*\n?([\s\S]*?)```/g)];
  if (fenced.length) return fenced[fenced.length - 1][1].trim();
  const plain = [...text.matchAll(/```\s*\n?([\s\S]*?)```/g)];
  if (plain.length) return plain[plain.length - 1][1].trim();
  const opener = text.match(/```(?:json)?\s*\n?/);
  if (opener) return text.slice(opener.index + opener[0].length).trim();
  return text.trim();
}

/**
 * Did the model actually answer?
 *
 * The distinction this draws is the whole point: a well-formed body containing
 * an EMPTY array is a real answer — "I read the manuscript and found none of
 * these" — while a body with no parseable JSON in it at all is a failed call
 * dressed as a successful one. The detectors used to treat both as "0 items
 * found", complete the job green, and report `detected: false`; a
 * safety-blocked or truncated-to-nothing response was then indistinguishable
 * from a manuscript that genuinely mentions no antibodies.
 *
 * Used as the `validate` callback on the LM call, so an unparseable body is
 * RETRIED rather than accepted. The prompts are explicit that an empty array is
 * the correct way to report finding nothing, so a model with nothing to say has
 * a valid response available to it.
 *
 * @param {string} text - the raw response body
 * @returns {boolean} true when the body carries parseable JSON
 */
function hasParseableBody(text) {
  const block = extractJsonBlock(text);
  if (!block.trim()) return false;
  try {
    JSON.parse(sanitizeJsonEscapes(block));
    return true;
  } catch {
    // A truncated body is still an answer if the salvage can recover an object
    // from it — that path exists precisely for responses cut at the token limit.
    return salvageTruncatedObjects(block).length > 0;
  }
}

module.exports = {
  sanitizeJsonEscapes,
  salvageTruncatedObjects,
  extractJsonBlock,
  hasParseableBody
};
