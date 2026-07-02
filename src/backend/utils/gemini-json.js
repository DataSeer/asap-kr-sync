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

module.exports = { sanitizeJsonEscapes };
