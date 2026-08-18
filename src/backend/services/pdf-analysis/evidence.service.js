/**
 * Evidence grounding — the shared contract that makes every detector's output
 * checkable against the manuscript.
 *
 * A detector's claim ("this manuscript uses anti-TH, RRID:AB_2201528") is only
 * usable downstream if we can point at the text that supports it. Every
 * KrtEntry therefore carries an `evidence` block:
 *
 *   { quote, offset, section, match }
 *
 * `quote` must be text that actually occurs in the converted markdown. This
 * module is what decides that — deterministically, with no LM involved — so a
 * fabricated quote cannot travel any further than the detector that invented it.
 *
 * Why whitespace-insensitive matching: the markdown is line-wrapped by the PDF
 * converter, so a sentence that reads as one line to the model is
 * "…anti-TH\nantibody (1:1000)…" in the file. A strict `indexOf` would reject
 * almost every truthful quote. We therefore match on a whitespace-collapsed,
 * case-folded projection of the document and map the hit back to a real offset.
 *
 * Match grades, weakest to strongest:
 *   - 'exact'   — the whole quote occurs in the document.
 *   - 'partial' — a leading run of the quote occurs (models routinely truncate
 *                 or ellipsise the tail of a long excerpt). Trustworthy enough
 *                 to keep, weak enough to be worth recording as such.
 *   - null      — nothing matched. The claim is ungrounded.
 */

const logger = require('../../utils/logger');

/** A partial match must cover at least this many normalized chars to count. */
const MIN_PARTIAL_CHARS = 40;

/** Cap on stored mentions per resource - enough to judge use-vs-citation. */
const MAX_MENTIONS = 12;

/** Below this length a "mention" is noise (matching "R" or "AB" everywhere). */
const MIN_MENTION_CHARS = 4;

/**
 * Characters that carry no textual meaning and that a model will never
 * reproduce: zero-width joiners/spaces, soft hyphens, BOM. Dropped from both
 * sides so a soft hyphen inside a word cannot break a true match.
 *
 * The backslash is here because the PDF-to-markdown converter escapes markdown
 * punctuation, and an RRID is full of underscores: the text says
 * `RRID:AB\_2687579` where every other layer — the author's KRT, the model's
 * output, the enrichment index — says `RRID:AB_2687579`. Searching for the
 * plain form found NOTHING in 127 of 164 distinct RRIDs across this corpus, and
 * in the affected documents it was total: 79 of 79 in one paper, 18 of 18 in
 * another. Every RRID in those manuscripts was invisible to identifier search.
 *
 * Dropping it is safe because it is symmetric — the haystack and the needle go
 * through this same folding, so this can only create matches, never break one.
 */
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2060\ufeff\\]/;

/**
 * Whitespace, including the Unicode spaces PDF converters emit that `\s` in a
 * naive check misses — non-breaking, thin, narrow and figure spaces. Docling
 * uses these inside units ("10 µL"), and a model rewrites them as plain spaces.
 */
const SPACE_RE = /[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;

/**
 * Fold one source character to its comparison form.
 *
 * The converted markdown is full of characters that a model reads correctly and
 * then writes back in a different codepoint — measured across the demo corpus:
 * MICRO SIGN (U+00B5) and GREEK MU (U+03BC) both occur; mathematical italic
 * letters (U+1D44E 𝑎, U+1D45A 𝑚) appear in formulas and come back as plain
 * `a`/`m`; ™ and … are everywhere. Comparing raw codepoints therefore rejects
 * quotes that are genuinely present in the text.
 *
 * NFKD + dropping combining marks folds all of those together, and also makes
 * precomposed "é" match a decomposed "e"+U+0301 — a difference no model
 * preserves reliably.
 *
 * May return more than one character (™ → "tm", … → "...") or none at all;
 * callers map every produced character back to the same source offset.
 *
 * @param {string} ch
 * @returns {string}
 */
function foldChar(ch) {
  if (INVISIBLE_RE.test(ch)) return '';
  if (SPACE_RE.test(ch)) return ' ';
  return ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Longest context we store per item. A paragraph in a Methods section is
 * usually 300–800 characters; a converted table row or a run-on paragraph can
 * be far longer. Storing the whole thing for every candidate would bloat the
 * job result (hundreds of items per submission, persisted as JSONB), so a long
 * paragraph is windowed around the quote and flagged as truncated.
 */
const MAX_CONTEXT_CHARS = 1200;

/**
 * Abbreviations that end in a period without ending a sentence. Without these
 * the sentence boundary lands mid-citation — "…as described (Smith et al." —
 * which is exactly where scientific prose puts them.
 */
const ABBREVIATIONS = [
  'al', 'e.g', 'i.e', 'cf', 'vs', 'etc', 'approx', 'ca', 'Fig', 'Figs', 'Eq',
  'Ref', 'Refs', 'Dr', 'Prof', 'St', 'No', 'Inc', 'Ltd', 'Co', 'Corp', 'Univ',
  'Dept', 'min', 'sec', 'hr', 'wt', 'vol', 'conc', 'temp'
];

/** Markdown ATX headings: `## Materials and Methods`. */
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

/**
 * Section titles that manuscripts use as bare lines when the converter did not
 * emit a real heading (MarkItDown does this). Matched only against short,
 * standalone lines so a sentence mentioning "methods" is not mistaken for one.
 */
const BARE_SECTION_RE = new RegExp(
  '^[ \\t]*((?:supplementary[ \\t]+|extended[ \\t]+data[ \\t]+)?'
  + '(?:abstract|introduction|background|results|discussion|conclusions?|'
  + '(?:materials[ \\t]+and[ \\t]+)?methods|experimental[ \\t]+procedures|star[ \\t]*methods|'
  + 'data[ \\t]+availability(?:[ \\t]+statement)?|code[ \\t]+availability(?:[ \\t]+statement)?|'
  + 'key[ \\t]+resources?[ \\t]+table|acknowledge?ments?|author[ \\t]+contributions|'
  + 'references|bibliography|figure[ \\t]+legends?|supplementary[ \\t]+information))'
  + '[ \\t]*:?[ \\t]*$',
  'gim'
);

/**
 * Build a reusable search index over the manuscript markdown.
 *
 * Cost is one pass over the document; the caller builds it once per job and
 * reuses it for every candidate, so grounding a few hundred items stays linear.
 *
 * @param {string} markdownText
 * @returns {{ text: string, normalized: string, map: number[], headings: object[] }}
 */
function buildEvidenceIndex(markdownText) {
  const text = typeof markdownText === 'string' ? markdownText : '';
  const chars = [];
  const map = [];
  let prevWasSpace = false;

  // Iterate by CODE POINT, not code unit: the mathematical italic letters this
  // corpus contains (U+1D44E 𝑎) are surrogate pairs, and indexing by `text[i]`
  // would hand foldChar half a character, which normalizes to nothing useful.
  // `i` still tracks the UTF-16 offset, because that is what String.slice takes.
  let i = 0;
  for (const sourceChar of text) {
    const at = i;
    i += sourceChar.length;
    const folded = foldChar(sourceChar);

    // Invisible character — contributes nothing, and mapping stays consistent
    // because we push to `chars` and `map` together.
    if (folded === '') continue;

    if (folded === ' ') {
      // Collapse every whitespace run to a single space, anchored at the first
      // character of the run so the mapped-back offset lands on real content.
      if (prevWasSpace) continue;
      chars.push(' ');
      map.push(at);
      prevWasSpace = true;
      continue;
    }

    // A fold may expand (™ → "tm"); every produced character maps back to the
    // same source offset, which is what an offset is for.
    for (const c of folded) {
      chars.push(c);
      map.push(at);
    }
    prevWasSpace = false;
  }

  return { text, normalized: chars.join(''), map, headings: extractHeadings(text) };
}

/**
 * Extract the document's section structure: every markdown heading, plus bare
 * lines that are unmistakably section titles.
 * @param {string} text
 * @returns {{ offset: number, level: number, title: string }[]} ordered by offset
 */
function extractHeadings(text) {
  const headings = [];

  HEADING_RE.lastIndex = 0;
  let m;
  while ((m = HEADING_RE.exec(text)) !== null) {
    headings.push({ offset: m.index, level: m[1].length, title: m[2].trim() });
  }

  BARE_SECTION_RE.lastIndex = 0;
  while ((m = BARE_SECTION_RE.exec(text)) !== null) {
    // Skip a bare line that a real ATX heading already covers at this offset.
    if (headings.some((h) => Math.abs(h.offset - m.index) < 4)) continue;
    headings.push({ offset: m.index, level: 1, title: m[1].trim() });
  }

  return headings.sort((a, b) => a.offset - b.offset);
}

/**
 * Resolve the heading path containing a character offset, e.g.
 * "Methods > Immunohistochemistry".
 * @param {object[]} headings - from extractHeadings
 * @param {number} offset
 * @returns {string} '' when the offset precedes every heading
 */
function sectionForOffset(headings, offset) {
  if (!Array.isArray(headings) || headings.length === 0 || typeof offset !== 'number') return '';

  const stack = [];
  for (const h of headings) {
    if (h.offset > offset) break;
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.title).join(' > ');
}

/**
 * Collapse a quote the same way the index collapses the document, so the two
 * are comparable.
 * @param {string} quote
 * @returns {string}
 */
function normalizeQuote(quote) {
  if (typeof quote !== 'string') return '';
  let out = '';
  let prevWasSpace = false;
  for (const ch of quote) {
    const folded = foldChar(ch);
    if (folded === '') continue;
    if (folded === ' ') {
      if (!prevWasSpace) out += ' ';
      prevWasSpace = true;
      continue;
    }
    out += folded;
    prevWasSpace = false;
  }
  return out.trim();
}

/**
 * Locate a quote in the indexed manuscript.
 *
 * @param {object} index - from buildEvidenceIndex
 * @param {string} quote
 * @returns {{ offset: number, section: string, match: 'exact'|'partial', matchedChars: number }|null}
 */
function locateQuote(index, quote) {
  if (!index || !index.normalized) return null;
  const needle = normalizeQuote(quote);
  if (!needle) return null;

  let at = index.normalized.indexOf(needle);
  let match = 'exact';
  let matchedChars = needle.length;

  if (at === -1) {
    // Models routinely return a truncated or ellipsised excerpt. Retry with a
    // leading run long enough that a coincidental hit is implausible.
    const probeLength = Math.max(MIN_PARTIAL_CHARS, Math.floor(needle.length / 2));
    if (needle.length < MIN_PARTIAL_CHARS) return null;
    const probe = needle.slice(0, probeLength);
    at = index.normalized.indexOf(probe);
    if (at === -1) return null;
    match = 'partial';
    matchedChars = probe.length;
  }

  const offset = index.map[at] ?? -1;
  return { offset, section: sectionForOffset(index.headings, offset), match, matchedChars };
}

/**
 * Extract the passage surrounding a located quote, so a curator can see WHERE
 * in the manuscript a candidate came from without opening the PDF.
 *
 * Returns one stored string plus two sets of offsets into it, which gives the
 * UI a collapsed and an expanded view from a single payload:
 *
 *   - collapsed → `context.slice(sentenceStart, sentenceEnd)` — the sentence
 *   - expanded  → the whole `context` — the paragraph
 *   - highlight → `context.slice(quoteStart, quoteEnd)` — what was matched
 *
 * Storing the paragraph once and slicing it beats storing sentence and
 * paragraph separately: no duplicated text in a JSONB column that already holds
 * hundreds of items.
 *
 * @param {string} text - the manuscript markdown
 * @param {number} offset - char offset where the quote starts
 * @param {number} quoteLength - length of the matched quote in the ORIGINAL text
 * @returns {object|null} context block, or null when the offset is unusable
 */
function extractContext(text, offset, quoteLength) {
  if (typeof text !== 'string' || typeof offset !== 'number' || offset < 0 || offset >= text.length) {
    return null;
  }

  // Paragraph bounds: markdown separates paragraphs with a blank line. Table
  // rows and list items are their own lines, which keeps those tight too.
  let start = text.lastIndexOf('\n\n', offset);
  start = start === -1 ? 0 : start + 2;
  let end = text.indexOf('\n\n', offset);
  end = end === -1 ? text.length : end;

  const quoteEndAbs = Math.min(end, offset + Math.max(0, quoteLength || 0));
  let truncated = false;

  // A very long paragraph is windowed around the quote rather than stored whole.
  if (end - start > MAX_CONTEXT_CHARS) {
    const slack = Math.max(0, MAX_CONTEXT_CHARS - (quoteEndAbs - offset));
    const before = Math.floor(slack / 2);
    const windowStart = Math.max(start, offset - before);
    const windowEnd = Math.min(end, windowStart + MAX_CONTEXT_CHARS);
    // Snap to word boundaries so the window never cuts mid-word.
    start = windowStart > start ? nextWordBoundary(text, windowStart) : start;
    end = windowEnd < end ? previousWordBoundary(text, windowEnd) : end;
    truncated = true;
  }

  const context = text.slice(start, end).trim();
  // trim() may have shifted the left edge; re-anchor the quote against it.
  const leadingTrimmed = text.slice(start, end).length - text.slice(start, end).trimStart().length;
  const quoteStart = Math.max(0, offset - start - leadingTrimmed);
  const quoteEnd = Math.min(context.length, quoteStart + Math.max(0, quoteEndAbs - offset));

  const { sentenceStart, sentenceEnd } = sentenceBoundsAround(context, quoteStart, quoteEnd);

  return { context, quoteStart, quoteEnd, sentenceStart, sentenceEnd, truncated };
}

/**
 * How many characters of the ORIGINAL text the match covered.
 *
 * The normalized projection collapses whitespace and folds characters, so a
 * quote's own length is not its footprint in the source. Map the end of the
 * matched span back through the index instead.
 *
 * @param {object} index
 * @param {{ offset: number, matchedChars: number }} located
 * @param {string} quote
 * @returns {number}
 */
function matchedOriginalLength(index, located, quote) {
  const at = index.map.indexOf(located.offset);
  if (at === -1) return quote.length;
  const endIdx = Math.min(index.map.length - 1, at + located.matchedChars - 1);
  return Math.max(1, (index.map[endIdx] ?? located.offset) - located.offset + 1);
}

/** Move forward to the next whitespace-delimited word start. */
function nextWordBoundary(text, index) {
  let i = index;
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Move back to the end of the previous whole word. */
function previousWordBoundary(text, index) {
  let i = index;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

/**
 * Sentence containing [from, to) inside `context`.
 *
 * Scans for terminal punctuation followed by whitespace, skipping the
 * abbreviations that pepper scientific prose ("Smith et al. 2020", "e.g.",
 * "approx. 5 min") so the boundary doesn't land mid-citation. Falls back to the
 * whole context when no boundary is found — a short paragraph IS the sentence.
 *
 * @param {string} context
 * @param {number} from
 * @param {number} to
 * @returns {{ sentenceStart: number, sentenceEnd: number }}
 */
function sentenceBoundsAround(context, from, to) {
  const isBoundaryAt = (i) => {
    if (!'.!?'.includes(context[i])) return false;
    // Must be followed by whitespace (or be the very end).
    if (i + 1 < context.length && !/\s/.test(context[i + 1])) return false;
    // Not an abbreviation, and not a decimal point ("0.5").
    const before = context.slice(Math.max(0, i - 12), i);
    if (ABBREVIATIONS.some((a) => new RegExp(`(^|[\\s(])${a.replace('.', '\\.')}$`, 'i').test(before))) return false;
    if (/\d$/.test(before) && /^\s*\d/.test(context.slice(i + 1, i + 3))) return false;
    return true;
  };

  let sentenceStart = 0;
  for (let i = from - 1; i >= 0; i--) {
    if (isBoundaryAt(i)) {
      sentenceStart = i + 1;
      break;
    }
  }
  while (sentenceStart < context.length && /\s/.test(context[sentenceStart])) sentenceStart++;

  let sentenceEnd = context.length;
  for (let i = Math.max(to - 1, from); i < context.length; i++) {
    if (isBoundaryAt(i)) {
      sentenceEnd = i + 1;
      break;
    }
  }

  // Never return a sentence that fails to cover the quote.
  if (sentenceEnd < to) sentenceEnd = Math.min(context.length, to);
  if (sentenceStart > from) sentenceStart = from;

  return { sentenceStart, sentenceEnd };
}

/**
 * Pick the best-grounded evidence from a set of contributors.
 *
 * Every stage that REBUILDS a resource from its contributors needs this, and
 * each one having its own copy is how `evidence` went missing three separate
 * times (in-detector dedup, cross-detector merge, LM consolidation). One
 * implementation, one grading rule:
 *
 *   exact > partial > none, and carrying a context paragraph beats not.
 *
 * @param {object[]} evidences - candidate evidence blocks (nullish entries ignored)
 * @returns {object|null}
 */
function pickBestEvidence(evidences) {
  const grade = (e) => {
    if (!e || !e.match) return 0;
    const base = e.match === 'exact' ? 2 : 1;
    return e.context ? base + 2 : base;
  };
  let best = null;
  for (const candidate of evidences || []) {
    if (grade(candidate) > grade(best)) best = candidate;
  }
  return best || null;
}

/**
 * Ground a detector's items against the manuscript.
 *
 * Each item's candidate quote is looked up; on a hit the item gains a verified
 * `evidence` block, on a miss it is either dropped or kept-but-flagged.
 *
 * Dropping is the right default for LM detectors (an unlocatable quote means
 * the model invented the passage) but wrong for detectors that never produce a
 * quote in the first place — a regex identifier hit is grounded by construction
 * and simply has no sentence attached. Callers pass `drop: false` for those.
 *
 * @param {object[]} items - KrtEntry[] (mutated copies are returned, input untouched)
 * @param {object} index - from buildEvidenceIndex
 * @param {object} [options]
 * @param {boolean} [options.drop=true] - drop items whose quote cannot be located
 * @param {(item:object)=>string} [options.quoteOf] - how to read the candidate quote
 * @param {string} [options.label='detector'] - for logging
 * @returns {{ items: object[], stats: { total:number, exact:number, partial:number, ungrounded:number, dropped:number } }}
 */
function attachEvidence(items, index, options = {}) {
  const { quoteOf = defaultQuoteOf, label = 'detector' } = options;

  const stats = {
    total: 0, exact: 0, partial: 0, ungrounded: 0, dropped: 0,
    verified: 0, embellished: 0, unsupported: 0
  };
  const out = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    stats.total++;

    const claimedQuote = String(quoteOf(item) || '').trim();
    const claimed = { quote: claimedQuote, identifier: String(item.identifier || '').trim() };

    // A detector that already knows its own offset (the identifier scan) is
    // grounded by construction — no claim to verify, only a section to fill.
    if (item.evidence && typeof item.evidence.offset === 'number' && item.evidence.offset >= 0) {
      const section = item.evidence.section || sectionForOffset(index.headings, item.evidence.offset);
      const context = extractContext(index.text, item.evidence.offset, (item.evidence.quote || '').length);
      stats.exact++; stats.verified++;
      out.push({
        ...item,
        evidence: {
          ...item.evidence, section, ...(context || {}),
          claimed,
          mentions: collectMentions(index, item, item.evidence.offset),
          verification: { status: 'verified', quoteVerbatim: true, identifierInText: true, nameInText: true }
        }
      });
      continue;
    }

    const located = locateQuote(index, claimedQuote);
    const identifierInText = identifierOccursInText(index, claimed.identifier);
    const nameInText = findAllOccurrences(index, item.resourceName, 1).length > 0;

    // THREE outcomes, and none of them discards what the model claimed.
    //
    //   verified    - the claimed quote is literally in the manuscript
    //   embellished - it is not, but the RESOURCE is (identifier or name).
    //                 Observed repeatedly: the model reads "broom" and
    //                 "ab41489" from the text, then writes a quote carrying the
    //                 matching RRID from its own knowledge. The identifier is
    //                 usually CORRECT; only the quote is not verbatim.
    //                 Discarding these was pure recall loss.
    //   unsupported - neither the quote nor the resource is in the text.
    const status = located ? 'verified' : ((identifierInText || nameInText) ? 'embellished' : 'unsupported');
    stats[status]++;

    if (located) {
      stats[located.match]++;
      const originalLength = matchedOriginalLength(index, located, claimedQuote);
      const context = extractContext(index.text, located.offset, originalLength);
      out.push({
        ...item,
        evidence: {
          quote: claimedQuote,
          offset: located.offset,
          section: located.section,
          match: located.match,
          ...(context || {}),
          claimed,
          mentions: collectMentions(index, item, located.offset),
          verification: { status, quoteVerbatim: true, identifierInText, nameInText }
        }
      });
      continue;
    }

    stats.ungrounded++;
    // The claim is PRESERVED, never blanked. `quote` stays empty because that
    // field means "text located in the document" - the two must not share a
    // channel, or embellishment becomes unmeasurable after the fact.
    const mentions = collectMentions(index, item, null);
    const primary = mentions[0] || null;
    out.push({
      ...item,
      evidence: {
        quote: '',
        offset: primary ? primary.offset : -1,
        section: primary ? primary.section : '',
        match: null,
        ...(primary ? (extractContext(index.text, primary.offset, (item.resourceName || '').length) || {}) : {}),
        claimed,
        mentions,
        verification: { status, quoteVerbatim: false, identifierInText, nameInText }
      }
    });
  }

  if (stats.unsupported > 0 || stats.embellished > 0) {
    logger.info(`Evidence verification (${label})`, {
      total: stats.total, verified: stats.verified,
      embellished: stats.embellished, unsupported: stats.unsupported,
      verbatimRate: stats.total > 0 ? Math.round((stats.verified / stats.total) * 100) + '%' : 'n/a'
    });
  }

  return { items: out, stats };
}

/**
 * Every place a resource is mentioned, not just the first.
 *
 * `locateQuote` returns the FIRST hit, which is fine for showing one span and
 * wrong for judging use-vs-citation: a tool named once in Methods and again in
 * the reference list is a used resource, while one appearing ONLY among the
 * references is probably just cited. That distinction needs all the positions.
 *
 * Gathered from the identifier (most specific) and the resource name,
 * deduplicated by offset and ordered so a usage section comes first.
 *
 * @param {object} index
 * @param {object} item - the KrtEntry being grounded
 * @param {number|null} preferredOffset - the located span, ranked first when present
 * @returns {{offset:number, section:string, via:string}[]}
 */
function collectMentions(index, item, preferredOffset) {
  const found = new Map();

  for (const { needle, via } of [
    { needle: identifierNeedle(item.identifier), via: 'identifier' },
    { needle: item.resourceName, via: 'name' }
  ]) {
    if (!needle) continue;
    for (const hit of findAllOccurrences(index, needle, MAX_MENTIONS)) {
      if (!found.has(hit.offset)) found.set(hit.offset, { ...hit, via });
    }
  }

  const mentions = [...found.values()];
  mentions.sort((a, b) => {
    if (preferredOffset !== null) {
      if (a.offset === preferredOffset) return -1;
      if (b.offset === preferredOffset) return 1;
    }
    const rank = (m) => (isCitationSection(m.section) ? 1 : 0);
    const byRank = rank(a) - rank(b);
    return byRank !== 0 ? byRank : a.offset - b.offset;
  });
  return mentions.slice(0, MAX_MENTIONS);
}

/**
 * Every occurrence of `needle`, whitespace/Unicode-folding aware.
 * @param {object} index
 * @param {string} needle
 * @param {number} [cap]
 * @returns {{offset:number, section:string}[]}
 */
function findAllOccurrences(index, needle, cap = MAX_MENTIONS) {
  const n = normalizeQuote(needle);
  if (!n || n.length < MIN_MENTION_CHARS || !index || !index.normalized) return [];

  const out = [];
  let at = index.normalized.indexOf(n);
  while (at !== -1 && out.length < cap) {
    const offset = index.map[at];
    if (typeof offset === 'number' && offset >= 0) {
      out.push({ offset, section: sectionForOffset(index.headings, offset) });
    }
    at = index.normalized.indexOf(n, at + n.length);
  }
  return out;
}

/**
 * The searchable core of an identifier: the bare token, since a manuscript
 * writes "RRID: AB_123" / "RRID:AB_123" / "AB_123" interchangeably.
 * @param {string} identifier
 * @returns {string}
 */
function identifierNeedle(identifier) {
  const raw = String(identifier || '').split(/[;,]/)[0].trim();
  if (!raw) return '';
  const token = raw.replace(/^\s*(RRID|DOI|Cat|Catalog)[\s:#]*/i, '').trim();
  return token.length >= MIN_MENTION_CHARS ? token : '';
}

/**
 * Does any part of this identifier actually appear in the manuscript?
 * @param {object} index
 * @param {string} identifier
 * @returns {boolean}
 */
function identifierOccursInText(index, identifier) {
  const needle = identifierNeedle(identifier);
  return needle ? findAllOccurrences(index, needle, 1).length > 0 : false;
}

/**
 * Reference lists and bibliographies - a mention here is a citation, not a use.
 * @param {string} section
 * @returns {boolean}
 */
function isCitationSection(section) {
  return /referen|bibliograph|citation|literature cited/i.test(String(section || ''));
}

/**
 * Default reader for an item's candidate quote. Detectors put their excerpt in
 * different places; this covers the shapes in use without each caller having to
 * pass a getter.
 * @param {object} item
 * @returns {string}
 */
function defaultQuoteOf(item) {
  return item?.evidence?.quote
    || item?.detectorMeta?.text_excerpt
    || item?.detectorMeta?.context
    || '';
}

module.exports = {
  MIN_PARTIAL_CHARS,
  foldChar,
  buildEvidenceIndex,
  pickBestEvidence,
  findAllOccurrences,
  collectMentions,
  identifierNeedle,
  isCitationSection,
  extractContext,
  sentenceBoundsAround,
  extractHeadings,
  sectionForOffset,
  normalizeQuote,
  locateQuote,
  attachEvidence
};
