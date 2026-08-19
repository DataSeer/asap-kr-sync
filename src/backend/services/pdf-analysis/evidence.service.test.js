/**
 * Tests for the evidence grounding service.
 *
 * The point of this module is that an ungrounded claim cannot travel, so the
 * cases that matter are:
 *   - a truthful quote is found even though the markdown line-wrapped it
 *   - a fabricated quote is NOT found
 *   - a truncated/ellipsised quote still grounds, but as 'partial'
 *   - offsets map back to real positions in the ORIGINAL text
 *   - section paths nest correctly, incl. converters that emit bare titles
 *   - detectors that legitimately have no quote are kept, not dropped
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEvidenceIndex,
  extractHeadings,
  sectionForOffset,
  normalizeQuote,
  locateQuote,
  extractContext,
  identifierNeedle,
  findAllOccurrences,
  findNormalisedOccurrences,
  isCitationSection,
  attachEvidence
} = require('./evidence.service');

const MARKDOWN = `## Introduction

Parkinson's disease is characterised by dopaminergic loss.

## Materials and Methods

### Immunohistochemistry

Sections were incubated overnight with a rabbit
anti-TH antibody (1:1000, Abcam, RRID:AB_2201528) and imaged
on a Leica SP8 confocal microscope.

### Sequencing

Samples were pooled together and sequenced on a NextSeq 2000 (Illumina).

Data Availability

Raw reads are deposited in GEO under accession GSE328400.
`;

test('buildEvidenceIndex maps normalized offsets back to the original text', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const at = index.normalized.indexOf('anti-th antibody');
  assert.ok(at > -1, 'normalized projection should be case-folded');
  const original = index.map[at];
  assert.equal(MARKDOWN.slice(original, original + 16), 'anti-TH antibody');
});

test('locateQuote finds a quote the markdown line-wrapped', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  // One line to the model; two lines with a newline in the file.
  const found = locateQuote(index, 'a rabbit anti-TH antibody (1:1000, Abcam, RRID:AB_2201528)');
  assert.ok(found, 'a wrapped but truthful quote must ground');
  assert.equal(found.match, 'exact');
  assert.ok(MARKDOWN.slice(found.offset).startsWith('a rabbit'));
});

test('locateQuote rejects a fabricated quote', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const found = locateQuote(
    index,
    'Sections were incubated with a goat anti-GFAP antibody (1:500, Invitrogen)'
  );
  assert.equal(found, null);
});

test('locateQuote grades a truncated quote as partial', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const found = locateQuote(
    index,
    'Samples were pooled together and sequenced on a NextSeq 2000 and then processed elsewhere entirely'
  );
  assert.ok(found, 'a quote whose head is real should still ground');
  assert.equal(found.match, 'partial');
});

test('locateQuote does not partial-match on a too-short needle', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  // Short and wrong — must not be rescued by the partial path.
  assert.equal(locateQuote(index, 'anti-GFAP'), null);
});

test('normalizeQuote collapses whitespace and folds case', () => {
  assert.equal(normalizeQuote('  A\n\tB   C '), 'a b c');
  assert.equal(normalizeQuote(null), '');
});

test('extractHeadings finds ATX headings and bare section titles', () => {
  const headings = extractHeadings(MARKDOWN);
  const titles = headings.map((h) => h.title);
  assert.ok(titles.includes('Materials and Methods'));
  assert.ok(titles.includes('Immunohistochemistry'));
  assert.ok(titles.includes('Data Availability'), 'bare section lines count too');
  // Ordered by position in the document.
  const offsets = headings.map((h) => h.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
});

test('sectionForOffset returns the nested heading path', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const found = locateQuote(index, 'a rabbit anti-TH antibody');
  assert.equal(
    sectionForOffset(index.headings, found.offset),
    'Materials and Methods > Immunohistochemistry'
  );
});

test('sectionForOffset pops sibling headings instead of nesting them', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const found = locateQuote(index, 'Samples were pooled together');
  assert.equal(
    sectionForOffset(index.headings, found.offset),
    'Materials and Methods > Sequencing',
    'Sequencing must replace Immunohistochemistry, not stack under it'
  );
});

test('sectionForOffset returns empty before the first heading', () => {
  const index = buildEvidenceIndex('Front matter with no heading yet.\n\n## Methods\n\nWe did things.\n');
  assert.equal(sectionForOffset(index.headings, 3), '');
});

test('sectionForOffset includes a document title when the converter emits one', () => {
  // Docling emits the manuscript title as `#`, which makes every section its
  // child. The path stays literal — consumers test for a section by substring
  // rather than by position.
  const withTitle = '# A study of things\n\n## Methods\n\nWe did the thing carefully.\n';
  const index = buildEvidenceIndex(withTitle);
  const found = locateQuote(index, 'We did the thing carefully.');
  assert.equal(sectionForOffset(index.headings, found.offset), 'A study of things > Methods');
});

test('attachEvidence tags rather than drops — the claim always survives', () => {
  // Previously the second row was DELETED here, taking the model's claim with
  // it. Nothing is discarded at the detector any more: the row is tagged and
  // filtered later (mergeDetections), so embellishment stays measurable.
  const index = buildEvidenceIndex(MARKDOWN);
  const items = [
    { resourceName: 'anti-TH', detectorMeta: { text_excerpt: 'a rabbit anti-TH antibody (1:1000, Abcam' } },
    { resourceName: 'anti-GFAP', detectorMeta: { text_excerpt: 'a goat anti-GFAP antibody (1:500, Invitrogen) was used throughout' } }
  ];
  const { items: out, stats } = attachEvidence(items, index, { label: 'test' });

  assert.equal(out.length, 2, 'both rows survive the detector');
  assert.equal(out[0].evidence.verification.status, 'verified');
  assert.equal(out[0].evidence.section, 'Materials and Methods > Immunohistochemistry');

  assert.equal(out[1].evidence.verification.status, 'unsupported');
  assert.equal(
    out[1].evidence.claimed.quote,
    'a goat anti-GFAP antibody (1:500, Invitrogen) was used throughout',
    'the unverifiable claim is retained verbatim for evaluation'
  );
  assert.equal(stats.ungrounded, 1);
  assert.equal(stats.unsupported, 1);
});

test('attachEvidence keeps ungrounded items when drop is false', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const items = [{ resourceName: 'anti-GFAP', detectorMeta: { text_excerpt: 'nowhere in the document at all, not even close' } }];
  const { items: out, stats } = attachEvidence(items, index, { drop: false, label: 'test' });

  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.match, null);
  assert.equal(out[0].evidence.offset, -1);
  assert.equal(stats.dropped, 0);
});

test('attachEvidence preserves an offset the detector already knows', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const offset = MARKDOWN.indexOf('GSE328400');
  const items = [{
    resourceName: 'RNA-seq',
    evidence: { quote: 'GSE328400', offset, section: '', match: 'exact' }
  }];
  const { items: out } = attachEvidence(items, index, { label: 'identifier-scan' });

  assert.equal(out[0].evidence.offset, offset, 'a known offset must not be recomputed');
  assert.equal(out[0].evidence.section, 'Data Availability', 'but the section is filled in');
});

test('attachEvidence tolerates junk input', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const { items, stats } = attachEvidence([null, undefined, 'nope'], index, { label: 'test' });
  assert.equal(items.length, 0);
  // Non-objects are skipped outright rather than counted and dropped — they
  // never were candidates.
  assert.equal(stats.total, 0);
  assert.equal(stats.dropped, 0);
});

// ── Unicode folding ─────────────────────────────────────────────────────────
// Measured on the demo corpus: the converted markdown carries MICRO SIGN and
// GREEK MU side by side, mathematical italic letters inside formulas, ™, and
// 1002 ellipses. A model reads those correctly and writes back a different
// codepoint, so raw comparison rejected quotes that really are in the text.

test('micro sign in the document matches Greek mu in the quote', () => {
  const index = buildEvidenceIndex('Cells were treated with 10 µL of reagent overnight.');
  const found = locateQuote(index, 'treated with 10 μL of reagent');
  assert.ok(found, 'U+00B5 and U+03BC must compare equal');
  assert.equal(found.match, 'exact');
});

test('mathematical italic letters match their plain ASCII form', () => {
  const index = buildEvidenceIndex('The constant 𝑎 was fitted per animal in the model.');
  const found = locateQuote(index, 'The constant a was fitted per animal');
  assert.ok(found, 'U+1D44E folds to "a"');
});

test('a non-breaking space matches a plain space', () => {
  const index = buildEvidenceIndex('Imaged on a Leica SP8 confocal microscope for analysis.');
  const found = locateQuote(index, 'Imaged on a Leica SP8 confocal microscope');
  assert.ok(found);
});

test('a soft hyphen inside a word does not break the match', () => {
  const index = buildEvidenceIndex('Immuno­histochemistry was performed on free-floating sections.');
  const found = locateQuote(index, 'Immunohistochemistry was performed on free-floating');
  assert.ok(found);
});

test('accents match whether precomposed or decomposed', () => {
  const index = buildEvidenceIndex('Samples from Bogotá were processed within the same week.');
  const found = locateQuote(index, 'Samples from Bogotá were processed within');
  assert.ok(found);
});

test('a trademark sign folds so the surrounding text still matches', () => {
  const index = buildEvidenceIndex('Purified with the Wizard™ SV Gel and PCR Clean-Up System kit.');
  // NFKD folds ™ to "TM", so the model's plain "WizardTM" spelling matches.
  const found = locateQuote(index, 'Purified with the WizardTM SV Gel and PCR Clean-Up System');
  assert.ok(found);
});

test('offsets still map back to the ORIGINAL text after folding', () => {
  const text = 'Treated with 10 µL overnight, then 𝑎 was measured carefully.';
  const index = buildEvidenceIndex(text);
  const found = locateQuote(index, 'then a was measured carefully');
  assert.ok(found);
  // The offset must land on the real character in the source string.
  assert.equal(text.slice(found.offset, found.offset + 4), 'then');
});

test('folding does not make different text match', () => {
  const index = buildEvidenceIndex('Cells were treated with 10 µL of reagent overnight.');
  assert.equal(locateQuote(index, 'Cells were treated with 99 mL of a different reagent entirely'), null);
});

// ── Context extraction ──────────────────────────────────────────────────────
// One stored paragraph plus offsets gives the UI a collapsed (sentence) and an
// expanded (paragraph) view without duplicating text.

const CTX = `## Methods

### Immunohistochemistry

Sections were blocked for one hour. Free-floating sections were incubated overnight with a rabbit anti-TH antibody (1:1000, Abcam, RRID:AB_2201528) as described previously (Smith et al. 2020). Sections were then washed three times.

### Sequencing

Libraries were prepared and sequenced.
`;

test('extractContext returns the paragraph and locates the quote inside it', () => {
  const index = buildEvidenceIndex(CTX);
  const found = locateQuote(index, 'a rabbit anti-TH antibody');
  const ctx = extractContext(CTX, found.offset, 'a rabbit anti-TH antibody'.length);

  assert.ok(ctx.context.startsWith('Sections were blocked'), 'paragraph starts at the blank line');
  assert.ok(ctx.context.endsWith('washed three times.'), 'and ends at the next blank line');
  assert.equal(ctx.context.slice(ctx.quoteStart, ctx.quoteEnd), 'a rabbit anti-TH antibody');
  assert.equal(ctx.truncated, false);
});

test('the sentence slice covers the quote and stops at the real boundary', () => {
  const index = buildEvidenceIndex(CTX);
  const found = locateQuote(index, 'a rabbit anti-TH antibody');
  const ctx = extractContext(CTX, found.offset, 'a rabbit anti-TH antibody'.length);
  const sentence = ctx.context.slice(ctx.sentenceStart, ctx.sentenceEnd);

  assert.ok(sentence.includes('a rabbit anti-TH antibody'), 'the sentence must contain the quote');
  assert.ok(sentence.startsWith('Free-floating sections'), 'starts after the previous sentence');
  assert.ok(!sentence.includes('washed three times'), 'stops before the next sentence');
});

test('an abbreviation does not end the sentence early', () => {
  const index = buildEvidenceIndex(CTX);
  const found = locateQuote(index, 'a rabbit anti-TH antibody');
  const ctx = extractContext(CTX, found.offset, 25);
  const sentence = ctx.context.slice(ctx.sentenceStart, ctx.sentenceEnd);
  // "(Smith et al. 2020)" must not be treated as a boundary.
  assert.ok(sentence.includes('Smith et al. 2020'), 'et al. is not a sentence end');
});

test('a decimal point does not end the sentence', () => {
  const text = 'Cells were fixed. We used 0.5 mM of the compound for the assay. Then washed.';
  const at = text.indexOf('0.5 mM');
  const ctx = extractContext(text, at, 6);
  const sentence = ctx.context.slice(ctx.sentenceStart, ctx.sentenceEnd);
  assert.ok(sentence.startsWith('We used 0.5 mM'));
  assert.ok(sentence.includes('for the assay.'));
});

test('a very long paragraph is windowed around the quote and flagged', () => {
  const filler = 'word '.repeat(600); // ~3000 chars
  const text = `${filler}TARGETPHRASE ${filler}`;
  const at = text.indexOf('TARGETPHRASE');
  const ctx = extractContext(text, at, 'TARGETPHRASE'.length);

  assert.equal(ctx.truncated, true);
  assert.ok(ctx.context.length <= 1200, `expected <=1200, got ${ctx.context.length}`);
  assert.equal(ctx.context.slice(ctx.quoteStart, ctx.quoteEnd), 'TARGETPHRASE');
});

test('windowing does not cut mid-word', () => {
  const filler = 'antidisestablishmentarianism '.repeat(80);
  const text = `${filler}TARGET ${filler}`;
  const ctx = extractContext(text, text.indexOf('TARGET'), 6);
  assert.ok(!/^\S*\s/.test(ctx.context) || /^[A-Za-z]+/.test(ctx.context), 'starts on a word');
  assert.equal(ctx.context.slice(ctx.quoteStart, ctx.quoteEnd), 'TARGET');
});

test('a single-sentence paragraph yields sentence === paragraph', () => {
  const text = 'Imaged on a Leica SP8 confocal microscope.';
  const ctx = extractContext(text, text.indexOf('Leica'), 5);
  assert.equal(ctx.context.slice(ctx.sentenceStart, ctx.sentenceEnd), text);
});

test('extractContext refuses an unusable offset', () => {
  assert.equal(extractContext('abc', -1, 1), null);
  assert.equal(extractContext('abc', 99, 1), null);
  assert.equal(extractContext(null, 0, 1), null);
});

test('attachEvidence attaches the context block to a grounded item', () => {
  const index = buildEvidenceIndex(CTX);
  const items = [{ resourceName: 'anti-TH', detectorMeta: { text_excerpt: 'a rabbit anti-TH antibody (1:1000, Abcam' } }];
  const { items: out } = attachEvidence(items, index, { label: 'test' });

  const ev = out[0].evidence;
  assert.ok(ev.context.includes('Free-floating sections'), 'context is the surrounding paragraph');
  assert.equal(typeof ev.sentenceStart, 'number');
  assert.equal(typeof ev.quoteStart, 'number');
  assert.ok(ev.context.slice(ev.quoteStart, ev.quoteEnd).startsWith('a rabbit anti-TH'));
});

// ── Claim preservation, verification status, multi-mention ──────────────────
// The model's claim and the document's truth must never share a field: once
// `quote` is overwritten (or blanked), "how often does the model embellish?"
// becomes unanswerable — the same class of error as the author-seed problem.

const CLAIM_MD = `## Methods

Libraries were prepared and analysed with broom and Fiji. Sections were stained
with ab41489 overnight.

## References

48. J. Schindelin et al., Fiji: an open-source platform. Nature Methods (2012).
`;

test('a verbatim quote is verified and keeps the claim alongside it', () => {
  const index = buildEvidenceIndex(CLAIM_MD);
  const { items, stats } = attachEvidence(
    [{ resourceName: 'broom', identifier: '', detectorMeta: { text_excerpt: 'analysed with broom and Fiji' } }],
    index, { label: 'test' }
  );
  const ev = items[0].evidence;
  assert.equal(ev.verification.status, 'verified');
  assert.equal(ev.verification.quoteVerbatim, true);
  assert.equal(ev.claimed.quote, 'analysed with broom and Fiji', 'the claim is retained');
  assert.equal(stats.verified, 1);
});

test('an embellished quote is KEPT, with the claim preserved verbatim', () => {
  // The real observed failure: the resource is in the text, the quote is not —
  // the model added an RRID it knows from elsewhere.
  const index = buildEvidenceIndex(CLAIM_MD);
  const claimed = 'broom (1.0.12, RRID:SCR_026874);';
  const { items, stats } = attachEvidence(
    [{ resourceName: 'broom', identifier: 'RRID:SCR_026874', detectorMeta: { text_excerpt: claimed } }],
    index, { label: 'test' }
  );
  const ev = items[0].evidence;
  assert.equal(items.length, 1, 'the row is no longer discarded');
  assert.equal(ev.verification.status, 'embellished');
  assert.equal(ev.verification.quoteVerbatim, false);
  assert.equal(ev.verification.nameInText, true, 'the resource IS in the text');
  assert.equal(ev.verification.identifierInText, false, 'but its identifier is not');
  assert.equal(ev.claimed.quote, claimed, 'the exact claim survives for evaluation');
  assert.equal(ev.quote, '', 'and is NOT passed off as located text');
  assert.equal(stats.embellished, 1);
});

test('a wholly unsupported claim is tagged, not silently deleted', () => {
  const index = buildEvidenceIndex(CLAIM_MD);
  const { items, stats } = attachEvidence(
    [{ resourceName: 'Kilosort', identifier: 'RRID:SCR_999999', detectorMeta: { text_excerpt: 'spike sorting with Kilosort' } }],
    index, { label: 'test' }
  );
  assert.equal(items.length, 1, 'kept so evaluation can count it');
  assert.equal(items[0].evidence.verification.status, 'unsupported');
  assert.equal(items[0].evidence.claimed.quote, 'spike sorting with Kilosort');
  assert.equal(stats.unsupported, 1);
});

test('all mentions are collected, not just the first', () => {
  const index = buildEvidenceIndex(CLAIM_MD);
  const { items } = attachEvidence(
    [{ resourceName: 'Fiji', identifier: '', detectorMeta: { text_excerpt: 'analysed with broom and Fiji' } }],
    index, { label: 'test' }
  );
  const mentions = items[0].evidence.mentions;
  assert.ok(mentions.length >= 2, `Fiji appears in Methods AND References, got ${mentions.length}`);
  assert.ok(mentions.some((m) => /Methods/i.test(m.section)));
  assert.ok(mentions.some((m) => /References/i.test(m.section)));
});

test('a usage-section mention outranks a reference-list one', () => {
  const index = buildEvidenceIndex(CLAIM_MD);
  const { items } = attachEvidence(
    [{ resourceName: 'Fiji', identifier: '', detectorMeta: { text_excerpt: 'not a real quote at all here' } }],
    index, { label: 'test' }
  );
  // Ungrounded, so ordering is by section rank rather than the located span.
  assert.ok(/Methods/i.test(items[0].evidence.mentions[0].section),
    'Methods must rank above References for use-vs-citation');
});

test('identifierNeedle strips the scheme so "RRID: AB_1" finds "AB_1"', () => {
  assert.equal(identifierNeedle('RRID: AB_2201407'), 'AB_2201407');
  assert.equal(identifierNeedle('Cat #: 657012, RRID: AB_1'), '657012');
  assert.equal(identifierNeedle('AB'), '', 'too short to be a safe needle');
  assert.equal(identifierNeedle(''), '');
});

test('findAllOccurrences: a converter-escaped identifier is found by its plain form', () => {
  // The manuscript says `RRID:AB\_2687579`; the author's KRT, the model's output
  // and the enrichment index all say `RRID:AB_2687579`. Before the backslash was
  // folded away, 127 of 164 distinct RRIDs in the demo corpus were unreachable.
  const index = buildEvidenceIndex('Stained with anti-LAMP1 (RRID:AB\\_2687579) overnight.');
  assert.equal(findAllOccurrences(index, 'AB_2687579', 5).length, 1);
  assert.equal(findAllOccurrences(index, 'AB\\_2687579', 5).length, 1);
});

test('findAllOccurrences: folding the escape away keeps offsets on real text', () => {
  const text = 'Stained with anti-LAMP1 (RRID:AB\\_2687579) overnight.';
  const index = buildEvidenceIndex(text);
  const [hit] = findAllOccurrences(index, 'AB_2687579', 1);
  assert.ok(hit, 'expected a hit');
  // The offset must land on the identifier in the ORIGINAL string, escape and
  // all — a normalisation that shifted offsets would break every quote we show.
  assert.ok(text.slice(hit.offset).startsWith('AB\\_2687579'));
});

test('isCitationSection recognises bibliographies', () => {
  assert.equal(isCitationSection('References'), true);
  assert.equal(isCitationSection('Bibliography'), true);
  assert.equal(isCitationSection('Materials and Methods'), false);
});

/**
 * Separator-insensitive search.
 *
 * Converted manuscripts split and join words around punctuation without
 * changing meaning: the KRT says "anti-TagFP", the markdown says "anti -TagFP".
 * This is still an EXACT match of a normalised form — not a similarity score —
 * which is what makes it safe: symmetric on both sides, so it can only create
 * matches, never break one.
 */
const NORMALISED_MD = 'Blocked, then anti -TagFP nanobody conjugated with ATTO488 '
  + '(NanoTag, N0502 -At488 -L) overnight. Quantified in ImageJ and antimycin-A was added.';

test('findNormalisedOccurrences: a hyphen the converter moved does not hide a name', () => {
  const index = buildEvidenceIndex(NORMALISED_MD);
  const name = 'anti-TagFP nanobody conjugated with ATTO488';
  assert.equal(findAllOccurrences(index, name, 3).length, 0, 'exact search cannot see it');
  const hits = findNormalisedOccurrences(index, name, 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].normalised, true, 'the match is labelled, not passed off as exact');
  assert.ok(NORMALISED_MD.slice(hits[0].offset).startsWith('anti -TagFP'),
    'the offset lands on the real text, not the normalised copy');
});

test('findNormalisedOccurrences: works for identifiers too', () => {
  // Catalog numbers get the same treatment: "N0502-At488-L" vs "N0502 -At488 -L".
  const index = buildEvidenceIndex(NORMALISED_MD);
  assert.equal(findAllOccurrences(index, 'N0502-At488-L', 3).length, 0);
  assert.equal(findNormalisedOccurrences(index, 'N0502-At488-L', 3).length, 1);
});

test('findNormalisedOccurrences: joins and splits are the same to it', () => {
  const index = buildEvidenceIndex(NORMALISED_MD);
  assert.equal(findNormalisedOccurrences(index, 'Image J', 3).length, 1, 'split name vs joined text');
  assert.equal(findNormalisedOccurrences(index, 'Antimycin A', 3).length, 1, 'space vs hyphen');
});

test('findNormalisedOccurrences: too short to be safe is refused', () => {
  // "IL-2" collapses to "il2" — three characters, and it would hit far too
  // much. The floor is what stops normalisation becoming fuzzy matching.
  const index = buildEvidenceIndex('Treated with IL2 and IL-2 receptor blockade.');
  assert.equal(findNormalisedOccurrences(index, 'IL-2', 5).length, 0);
});

test('findNormalisedOccurrences: absent is still absent', () => {
  const index = buildEvidenceIndex(NORMALISED_MD);
  assert.equal(findNormalisedOccurrences(index, 'ZzzNotInThisPaper999', 3).length, 0);
});
