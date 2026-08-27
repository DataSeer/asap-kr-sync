/**
 * Check an author's identifiers against the MANUSCRIPT, and nothing else.
 *
 * This module compares two things only: what the author wrote, and what the
 * paper says. Not what a detector produced, and above all not what a curated
 * enrichment list knows — those belong to other steps.
 *
 * ── The bug this replaces ────────────────────────────────────────────────────
 *
 * `compareWithCandidates` raised a conflict by comparing the author's cell with
 * `supplier.candidate[field]` and labelling the result `manuscriptValue`. For an
 * `identifier-scan` candidate that field is populated from the curated list: the
 * scanner finds one RRID in the text, looks it up, and attaches every identifier
 * and homepage URL the list holds for that tool. All of it was then presented to
 * the curator as what the manuscript says.
 *
 * Observed on a real submission. The row was flagged `Incoherence`, and of the
 * four values shown as "manuscript", three appear nowhere in it:
 *
 *     RRID:SCR_014269                                    in the text
 *     http://ric.uthscsa.edu/mango/                      NOT in the text
 *     https://imagej.net/ij/plugins/time-series.html     NOT in the text
 *     https://imagej.nih.gov/ij/plugins/time-series.html NOT in the text
 *
 * The author's row was correct. The app told them it disagreed with the paper,
 * quoting a source that never said it — asking someone to change good data on
 * the authority of something that does not exist. Two of the three conflicts on
 * that instance were of this kind.
 *
 * ── Three verdicts, per identifier ───────────────────────────────────────────
 *
 *   found            the author's value occurs in the manuscript. Verified.
 *
 *   possible_mismatch it does not occur, AND the text carries a DIFFERENT value
 *                     OF THE SAME KIND close to where this resource is named.
 *                     Worth a look; still not proof the author is wrong, since
 *                     the paper can be the thing that is out of date.
 *
 *   absent            it does not occur, and nothing nearby contradicts it. NOT
 *                     an error: a KRT is allowed to carry more than the
 *                     manuscript prints, and most good tables do. Reported so
 *                     the curator knows it is unverified, and reported quietly.
 *
 * Same kind matters. An author RRID missing from the text, with a different RRID
 * beside the resource's name, is worth raising. An author DOI missing, with an
 * RRID nearby, is not — those are different claims, and comparing them would
 * manufacture a disagreement out of two unrelated facts.
 */

'use strict';

const { extractAll } = require('../krt/identifier-extractor');

/**
 * How far either side of a mention to look for a competing identifier.
 *
 * A paragraph, roughly. Wide enough that "(RRID:SCR_014269)" a sentence after
 * the tool's name is found; narrow enough that an identifier belonging to a
 * different reagent three paragraphs down is not mistaken for this one's.
 */
const CONTEXT_CHARS = 600;

/**
 * Identifier kinds `extractAll` reports, in the order a disagreement matters.
 *
 * `url` is deliberately last and deliberately included: a homepage is the weakest
 * kind of identifier and the one enrichment lists carry most of, so it is the
 * most likely to differ for reasons that say nothing about the author.
 */
const KINDS = ['doi', 'rrid', 'scr', 'cas', 'accession', 'addgene', 'pdb', 'pmid', 'url'];

/** The kind of identifier a single author-written value is. */
function kindOf(value) {
  const found = extractAll(String(value || ''));
  return KINDS.find((k) => found[k]) || null;
}

/**
 * Text either side of each mention, joined — the neighbourhood of a resource.
 *
 * Markdown escaping is stripped first. The conversion writes `SCR\_014269` for
 * `SCR_014269`, and the identifier patterns do not match through a backslash —
 * so without this an RRID sitting right beside the resource's name is invisible
 * and every unverified value reads as `absent`. That is the same escaping the
 * presence check already normalises away, and it is why an author identifier
 * that IS in the paper was being reported as missing.
 */
function unescapeMarkdown(text) {
  return String(text || '').replace(/\\([_*[\]()~`>#+\-.!])/g, '$1');
}

function contextAround(text, mentions) {
  if (!text || !Array.isArray(mentions) || !mentions.length) return '';
  return unescapeMarkdown(mentions
    .map((m) => text.slice(Math.max(0, m.offset - CONTEXT_CHARS), m.offset + CONTEXT_CHARS))
    .join('\n'));
}

/**
 * Verdict for one author-written identifier.
 *
 * @param {object} args
 * @param {string} args.value      the author's own text for this part
 * @param {boolean} args.foundInText whether the presence check located it
 * @param {string} args.context    manuscript text around this row's mentions
 * @returns {{value, verdict, kind, competing?}}
 */
function verdictFor({ value, foundInText, context }) {
  const kind = kindOf(value);
  if (foundInText) return { value, verdict: 'found', kind };

  // Nothing to compare against — the row was never located in the text, so there
  // is no neighbourhood to have found a competing value in.
  if (!context) return { value, verdict: 'absent', kind };

  // Only a value of the SAME kind can disagree with this one.
  if (!kind) return { value, verdict: 'absent', kind };

  // Unescaped here as well as in contextAround. It is idempotent, and a caller
  // that passes raw manuscript text would otherwise get a quiet `absent` for
  // every identifier the conversion escaped — the failure being that nothing
  // looks wrong, there are simply no mismatches ever.
  const nearby = extractAll(unescapeMarkdown(context))[kind];
  const competing = Array.isArray(nearby) ? nearby[0] : nearby;
  if (!competing) return { value, verdict: 'absent', kind };

  const same = String(competing).replace(/[\s\\]/g, '').toLowerCase()
    === String(value).replace(/[\s\\]/g, '').toLowerCase();
  // The same value written differently — escaped, spaced, cased — is not a
  // disagreement. The conversion mangles identifiers this way routinely.
  if (same) return { value, verdict: 'found', kind };

  return { value, verdict: 'possible_mismatch', kind, competing: String(competing) };
}

/**
 * Verify every identifier on one author row against the manuscript.
 *
 * @param {object} args
 * @param {object[]} args.identifiers per-part results from presenceForRows
 *   (`{ value, found }`), which already handles the conversion's escaping
 * @param {object} args.index        the evidence index (carries `text`)
 * @param {object[]} args.mentions   where this row was located in the text
 * @returns {{ identifiers: object[], mismatches: object[], unverified: object[] }}
 */
function verifyRow({ identifiers, index, mentions }) {
  const context = contextAround(index?.text, mentions);
  const verdicts = (identifiers || []).map((part) => verdictFor({
    value: part.value,
    foundInText: !!part.found,
    context
  }));

  return {
    identifiers: verdicts,
    // The actionable subset: a different value of the same kind sits beside this
    // resource in the paper.
    mismatches: verdicts.filter((v) => v.verdict === 'possible_mismatch'),
    // Present in the KRT, absent from the paper, nothing contradicting it. Shown
    // so a curator knows what was and was not checked — never as an error.
    unverified: verdicts.filter((v) => v.verdict === 'absent')
  };
}

module.exports = { verifyRow, verdictFor, kindOf, CONTEXT_CHARS };
