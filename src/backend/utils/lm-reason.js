/**
 * Scrub the internal identifiers out of a reason string an LM wrote.
 *
 * A reason is shown to the curator verbatim, and the model has two ways of
 * referring to things the curator has no name for: the `ref` numbers the
 * consolidation prompt gives its candidates ("merged refs 0 and 4"), and raw
 * KRT row UUIDs ("row a3d12f45-…"). Both are implementation detail.
 *
 * This existed three times, and the backend's two copies were each HALF of it:
 * krt-generation stripped refs but not UUIDs, kr-comparison stripped UUIDs but
 * not refs, so a reason that carried the other kind reached the API uncleaned.
 * The frontend's copy already did both and was quietly covering for them at
 * display time — but only in the Generated KRT table, so anything else reading
 * the field (the report, an export, the audit record) still saw the raw text.
 *
 * The frontend keeps its own copy — it cannot require this module — and
 * `generated-krt.js` carries the same rules in the same order. The tests on
 * both sides use the same cases.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(UUID, 'gi');
const REFS_RE = /\(?\s*\brefs?\b\s*#?\s*\d+(\s*(?:,|and|&|\/)\s*#?\s*\d+)*\s*\)?/gi;
const PARENTHESISED_ROW_RE = new RegExp(`\\(\\s*(?:row\\s+)?${UUID}\\s*\\)`, 'gi');
const NAMED_ROW_RE = new RegExp(`\\brow\\s+${UUID}`, 'gi');

/**
 * @param {string} reason - the raw reason from the model
 * @returns {string} the reason with internal refs removed, or '' for nothing
 */
function cleanReason(reason) {
  if (!reason) return '';
  return String(reason)
    // Removals leave a SPACE, not nothing: the patterns consume the whitespace
    // on both sides of what they match, so deleting outright welded the
    // surrounding words together — "merged refs 1, 2 & 3 into one row" came out
    // as "mergedinto one row". The collapse below turns the leftovers back into
    // single spaces.
    .replace(REFS_RE, ' ')
    // A parenthesised row id is pure noise — the row itself is on screen.
    .replace(PARENTHESISED_ROW_RE, ' ')
    // A row id used as the sentence's object needs words in its place, or the
    // sentence loses its subject: "matched row a3d12…" → "matched the matching
    // author row".
    .replace(NAMED_ROW_RE, 'the matching author row')
    .replace(UUID_RE, ' ')
    // Tidy up after the removals: doubled spaces, a space before punctuation,
    // and the dangling connectors a stripped clause leaves at either end.
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, '')
    .trim();
}

module.exports = { cleanReason };
