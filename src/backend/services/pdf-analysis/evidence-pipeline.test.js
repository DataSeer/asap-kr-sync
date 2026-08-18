/**
 * End-to-end guard: manuscript evidence must survive EVERY stage.
 *
 * `evidence` has now been silently dropped three separate times — by the
 * in-detector dedup, by the cross-detector merge, and by the LM consolidation.
 * Each stage rebuilds a resource from its contributors by enumerating fields,
 * so any field nobody names disappears, and the symptom shows up far away
 * (an empty context line in a modal, a suggestion with nowhere to point).
 *
 * The per-stage unit tests each cover their own stage. This one walks the whole
 * chain, which is the only place the *cumulative* loss is visible.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildEvidenceIndex, attachEvidence } = require('./evidence.service');
const { dedupeKrtItems } = require('./dedupe-krt-items.service');
const { mergeDetections } = require('./merge-detections.service');
const { buildKrtFromLM } = require('./krt-generation.service');

const MARKDOWN = `## Materials and Methods

### Reagents

Sulpiride was from MilliporeSigma (S7771). Antibodies used are anti-TH in rabbit
(Millipore, 657012, RRID: AB_2201407, 1:1,000).
`;

/** A detector's raw output, before grounding. */
const rawItem = (over = {}) => ({
  resourceType: 'Chemical, peptide, or recombinant protein',
  resourceName: 'Sulpiride',
  identifier: 'S7771',
  source: 'MilliporeSigma',
  newReuse: 'reuse',
  origin: 'materials-gemini',
  confidence: 0.95,
  additionalInformation: '',
  evidence: { quote: 'Sulpiride was from MilliporeSigma (S7771).', offset: -1, section: '', match: null },
  detectorMeta: {},
  ...over
});

test('evidence survives detector → grounding → dedupe', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const { items: grounded } = attachEvidence([rawItem()], index, { label: 'test' });
  assert.ok(grounded[0].evidence.context, 'grounding attaches the context paragraph');

  const deduped = dedupeKrtItems(grounded, 'materials');
  assert.ok(deduped[0].evidence, 'STAGE 1: dedupe must not drop evidence');
  assert.ok(deduped[0].evidence.context, 'including its context');
  assert.equal(deduped[0].evidence.section, 'Materials and Methods > Reagents');
});

test('evidence survives the cross-detector merge', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const { items: grounded } = attachEvidence([rawItem()], index, { label: 'test' });
  const deduped = dedupeKrtItems(grounded, 'materials');

  const merged = mergeDetections([{ source: 'materials_detection', items: deduped }]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].evidence, 'STAGE 2: merge must lift evidence to the top level');
  assert.ok(merged[0].evidence.context);
});

test('evidence survives LM consolidation into the Generated KRT', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const { items: grounded } = attachEvidence([rawItem()], index, { label: 'test' });
  const candidates = mergeDetections([
    { source: 'materials_detection', items: dedupeKrtItems(grounded, 'materials') }
  ]);

  // What the consolidation LM returns: curated fields plus the refs it merged.
  // Note it returns NO evidence — the stage must recover it from the refs.
  const lmResponse = {
    resources: [{
      refs: [0],
      resourceType: 'Chemical, peptide, or recombinant protein',
      resourceName: 'Sulpiride',
      source: 'MilliporeSigma',
      identifier: 'S7771',
      newReuse: 'reuse',
      reason: 'kept'
    }],
    dropped: []
  };

  const { items } = buildKrtFromLM(candidates, lmResponse);
  assert.equal(items.length, 1);
  assert.ok(items[0].evidence, 'STAGE 3: consolidation must carry evidence from its refs');
  assert.ok(items[0].evidence.context, 'including the context a suggestion will render');
  assert.equal(items[0].evidence.section, 'Materials and Methods > Reagents');
});

test('a merged resource surfaces the BEST evidence across contributors', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const weak = rawItem({
    origin: 'identifier-scan',
    confidence: 0.99,
    evidence: { quote: 'S7771', offset: MARKDOWN.indexOf('S7771'), section: '', match: 'exact' }
  });
  const strong = rawItem({ confidence: 0.4 });

  const { items: grounded } = attachEvidence([weak, strong], index, { drop: false, label: 'test' });
  const merged = mergeDetections([{ source: 'materials_detection', items: dedupeKrtItems(grounded, 'materials') }]);

  assert.ok(merged[0].evidence.context, 'the contributor carrying a context paragraph wins');
});

/**
 * This used to assert that an ungrounded chain produced `evidence: null`, to
 * avoid rendering a hollow block. That protection was in the wrong place: it
 * was implemented by `pickBestEvidence` scoring every ungrounded record 0 —
 * indistinguishable from no record — so the block was deleted along with its
 * verification verdict.
 *
 * Deleting the verdict broke the thing that was supposed to keep the output
 * clean: `mergeDetections` filters on `evidence.verification.status ===
 * 'unsupported'`, and no item ever reached it carrying a status, so the filter
 * was dead code from the day it was written.
 *
 * With the verdict travelling, the filter does the job instead — and does it
 * better. An `unsupported` item is removed entirely rather than kept with its
 * evidence blanked, and an `embellished` item keeps the mentions and context
 * that make it useful. `quote` stays empty either way, because that field means
 * "text located in the document" and must never carry an unverified claim.
 */
test('an embellished item keeps its evidence; nothing unverified is presented as located', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  // Softcite-style: a real quote from the PDF that is not in the markdown. The
  // RESOURCE is in the markdown, so this is embellished, not unsupported.
  const item = rawItem({
    origin: 'softcite',
    evidence: { quote: 'a sentence that is not in this markdown at all, nowhere', offset: -1, section: '', match: null }
  });
  const { items: grounded } = attachEvidence([item], index, { drop: false, label: 'softcite' });
  const merged = mergeDetections([{ source: 'software_detection', items: dedupeKrtItems(grounded, 'software') }]);

  assert.equal(merged.length, 1, 'embellished survives the merge filter');
  assert.equal(merged[0].evidence.verification.status, 'embellished', 'the verdict reaches the merged resource');
  assert.equal(merged[0].evidence.quote, '', 'an unverified claim never occupies the located-text field');
  assert.equal(merged[0].evidence.claimed.quote, 'a sentence that is not in this markdown at all, nowhere',
    'what the model claimed is preserved, in its own channel');
  assert.ok(merged[0].evidence.mentions.length > 0, 'where the resource DOES appear is still reported');
});

test('an unsupported item is dropped at merge, not kept with blank evidence', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  // Neither the quote nor the resource is anywhere in the manuscript.
  const item = rawItem({
    resourceName: 'ZzzNotInThisPaper999',
    identifier: '',
    evidence: { quote: 'also entirely invented, nowhere in the text', offset: -1, section: '', match: null }
  });
  const { items: grounded } = attachEvidence([item], index, { drop: false, label: 'probe' });
  assert.equal(grounded[0].evidence.verification.status, 'unsupported');

  // Dropped inside the DETECTOR's own dedup, because dedupeKrtItems delegates
  // to mergeDetections and so applies the same filter. Naming the stage matters:
  // asserting only on the final merge would pass even if the item were being
  // lost somewhere else entirely, which is how the previous version of this
  // test hid the fact that the filter had never run at all.
  const deduped = dedupeKrtItems(grounded, 'software');
  assert.equal(deduped.length, 0, 'removed at in-detector dedup, the earliest point it can be');

  const merged = mergeDetections([{ source: 'software_detection', items: deduped }]);
  assert.equal(merged.length, 0, 'and it does not reappear downstream');
});

/**
 * `evidence` was the field that kept vanishing, but it was never the only one at
 * risk — the defect is the rebuild-by-enumeration pattern, not the field. A
 * sentinel sweep of the whole chain found ADDITIONAL INFORMATION going the same
 * way: `buildKrtFromLM` omitted it from the item it assembles, so every resource
 * the LM placed lost it, while the safety-net path below kept it — one output
 * table, two item shapes. Downstream it is a suggestion's `context` blurb.
 */
test('additionalInformation survives LM consolidation, on both paths', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const { items } = attachEvidence([rawItem({ additionalInformation: 'Used at 1:1,000' })], index, { label: 'materials' });
  const merged = mergeDetections([{ source: 'materials', items: dedupeKrtItems(items, 'materials') }]);

  // Path A — the LM placed the candidate.
  const placed = buildKrtFromLM(merged, {
    resources: [{ refs: [0], resourceName: 'Sulpiride', reason: 'kept' }]
  });
  assert.equal(placed.items[0].additionalInformation, 'Used at 1:1,000');

  // Path B — the LM forgot it and the safety net kept it.
  const net = buildKrtFromLM(merged, { resources: [] });
  assert.equal(net.items[0].additionalInformation, 'Used at 1:1,000');

  // Both paths must produce the SAME shape, or consumers see a field that
  // exists on some rows of one table and not others.
  assert.deepEqual(
    Object.keys(placed.items[0]).sort().filter(k => k !== 'reason'),
    Object.keys(net.items[0]).sort().filter(k => k !== 'reason')
  );
});

test('the LM\'s own additionalInformation wins over the detectors\' merged one', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  const { items } = attachEvidence([rawItem({ additionalInformation: 'detector text' })], index, { label: 'materials' });
  const merged = mergeDetections([{ source: 'materials', items: dedupeKrtItems(items, 'materials') }]);
  const out = buildKrtFromLM(merged, {
    resources: [{ refs: [0], resourceName: 'Sulpiride', additionalInformation: 'curated text', reason: 'kept' }]
  });
  assert.equal(out.items[0].additionalInformation, 'curated text');
});
