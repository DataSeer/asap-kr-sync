/**
 * For each identifier the author wrote: does the manuscript print it?
 *
 * Two verdicts, and neither is an error:
 *
 *   found    the paper prints it. Verified.
 *
 *   absent   the paper does not. NOT a defect — a KRT is allowed to carry more
 *            than the manuscript prints, and most good tables do: a tool's
 *            homepage is rarely in the methods. Reported so a curator knows what
 *            was and was not checked, and reported quietly.
 *
 * ── What this module is NOT ──────────────────────────────────────────────────
 *
 * It does not decide whether the author is WRONG. That question — is there a
 * different value for this thing in the paper? — belongs to the matcher, which
 * compares the author's row against detector candidates restricted to what the
 * text actually contains (`manuscriptClaim` in match-author-rows.service.js).
 *
 * This module briefly tried to answer it too, by scanning the text around each
 * mention for a competing identifier of the same kind. That worked for typed
 * identifiers and missed everything else: `strain code: 400` against a paper
 * reading `strain code: 001` is no RRID, DOI or accession, so it was reported
 * as merely absent while the paper printed the contradiction two words from the
 * resource's name. Catching it needed a bespoke label-matching heuristic with
 * its own false-positive surface.
 *
 * The matcher gets it right with no heuristic at all: a detector had already
 * read `strain code: 001` out of the manuscript, so restricting candidate values
 * to text-present ones leaves that comparison standing on its own. Measured on
 * the reported submission, that route raises exactly one conflict — the real
 * one — where the unrestricted comparison raised four.
 *
 * So the split is: the matcher says what the paper CONTRADICTS, this says what
 * the paper CORROBORATES. One question each.
 */

'use strict';

/**
 * Verdict for one author-written identifier.
 *
 * @param {object} args
 * @param {string} args.value        the author's own text for this part
 * @param {boolean} args.foundInText whether the presence check located it
 * @returns {{value: string, verdict: 'found'|'absent'}}
 */
function verdictFor({ value, foundInText }) {
  return { value, verdict: foundInText ? 'found' : 'absent' };
}

/**
 * Verify every identifier on one author row against the manuscript.
 *
 * @param {object} args
 * @param {object[]} args.identifiers per-part results from presenceForRows
 *   (`{ value, found }`), which already handles the conversion's escaping
 * @returns {{ identifiers: object[], unverified: object[] }}
 */
function verifyRow({ identifiers }) {
  const verdicts = (identifiers || []).map((part) => verdictFor({
    value: part.value,
    foundInText: !!part.found
  }));

  return {
    identifiers: verdicts,
    // Present in the KRT, absent from the paper. Shown as a note, never as an
    // error, and never with a correction attached — nothing contradicts it.
    unverified: verdicts.filter((v) => v.verdict === 'absent')
  };
}

module.exports = { verifyRow, verdictFor };
