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

test('an ungrounded chain stays clean rather than inventing an empty block', () => {
  const index = buildEvidenceIndex(MARKDOWN);
  // Softcite-style: a real quote from the PDF that is not in the markdown.
  const item = rawItem({
    origin: 'softcite',
    evidence: { quote: 'a sentence that is not in this markdown at all, nowhere', offset: -1, section: '', match: null }
  });
  const { items: grounded } = attachEvidence([item], index, { drop: false, label: 'softcite' });
  const merged = mergeDetections([{ source: 'software_detection', items: dedupeKrtItems(grounded, 'software') }]);

  assert.equal(merged[0].evidence, null, 'no match ⇒ null, not a fake block');
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
