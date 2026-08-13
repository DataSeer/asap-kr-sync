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
 * for balanced top-level objects (tracking string state so a brace inside a
 * quoted value doesn't confuse the depth count) and keep every object that
 * closed cleanly, discarding the partial tail.
 *
 * @param {string} text - the (possibly truncated) JSON body
 * @returns {object[]} the objects that were complete, [] if none
 */
function salvageTruncatedObjects(text) {
  const str = String(text || '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  // Rows live inside an array, which itself usually sits inside an envelope
  // object (`{"resources": [ … ]`). That envelope's opening brace means array
  // elements open and close at depth 1, not 0 — so anchor on the depth at which
  // the first array was entered. With a bare `{…},{…}` stream (no array) this
  // stays 0 and behaves the same way.
  let elementDepth = 0;
  let sawArray = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }

    if (ch === '[' && !sawArray) {
      // Entering the rows array. Anything open before it is the envelope, not a
      // row, so abandon that candidate and re-anchor here.
      elementDepth = depth;
      start = -1;
      sawArray = true;
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
        try {
          objects.push(JSON.parse(sanitizeJsonEscapes(candidate)));
        } catch {
          // A malformed complete-looking object is skipped, not fatal.
        }
        start = -1;
      }
      if (depth < elementDepth) depth = elementDepth; // stray closer — resynchronise
    }
  }

  return objects;
}

module.exports = { sanitizeJsonEscapes, salvageTruncatedObjects };
