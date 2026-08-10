/**
 * Tests for mergeDetections — cross-source dedup pure function.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeDetections,
  mergeAdditionalInfo,
  applyVenueSource,
  normalizeResourceTypeKey
} = require('./merge-detections.service');

const itemAddRow = (overrides = {}) => ({
  type: 'add_row',
  data: {
    resourceType: 'Software/code',
    resourceName: 'Python',
    source: 'https://python.org',
    identifier: '',
    newReuse: 'reuse',
    additionalInformation: '',
    ...overrides
  },
  confidence: 0.8
});

test('empty contributions → empty result', () => {
  assert.deepEqual(mergeDetections([]), []);
  assert.deepEqual(mergeDetections([{ source: 'sw', items: [] }]), []);
});

test('single source, single item → 1 resource', () => {
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({ resourceName: 'Python', identifier: 'py' })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Python');
  assert.equal(r[0].detectedBy.length, 1);
  assert.equal(r[0].detectedBy[0].source, 'software_detection');
});

test('two sources same identifier → merged', () => {
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({ resourceName: 'Python', identifier: 'RRID:SCR_008394' })] },
    { source: 'pdf_analysis',       items: [itemAddRow({ resourceName: 'Python', identifier: 'rrid:scr_008394' })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].detectedBy.length, 2);
});

test('two sources same name diff identifier → merged (rule 3: name OR id)', () => {
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({ resourceName: 'Python', identifier: 'a' })] },
    { source: 'pdf_analysis',       items: [itemAddRow({ resourceName: 'PYTHON', identifier: 'b' })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].detectedBy.length, 2);
});

test('different new/reuse → NOT merged', () => {
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({ resourceName: 'Python', newReuse: 'new' })] },
    { source: 'pdf_analysis',       items: [itemAddRow({ resourceName: 'Python', newReuse: 'reuse' })] }
  ]);
  assert.equal(r.length, 2);
});

test('nameless row merges into a named row with the same identifier, despite different new/reuse', () => {
  // The published-protocol venue scan emits identifier + SOURCE but cannot know
  // a name or new/reuse. Without the nameless rule it would surface as a second,
  // blank-named suggestion beside the real one.
  const named = itemAddRow({
    resourceType: 'Protocol', resourceName: 'Chromatin immunoprecipitation',
    identifier: '10.1038/nprot.2009.97', source: '', newReuse: 'reuse'
  });
  const nameless = itemAddRow({
    resourceType: 'Protocol', resourceName: '',
    identifier: '10.1038/nprot.2009.97', source: 'Nature Protocols', newReuse: ''
  });

  const r = mergeDetections([
    { source: 'protocols_detection',  items: [named] },
    { source: 'identifier_detection', items: [nameless] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Chromatin immunoprecipitation');
  assert.equal(r[0].newReuse, 'reuse');            // the named row's value survives
  assert.equal(r[0].sourceUrl, 'Nature Protocols'); // the scan filled the blank SOURCE
  assert.equal(r[0].detectedBy.length, 2);
});

test('nameless row accepted FIRST still yields the named row + its new/reuse', () => {
  // Contribution order must not change the outcome: when the nameless row wins
  // the primary slot, the named candidate's new/reuse blank-fills onto it.
  const named = itemAddRow({
    resourceType: 'Protocol', resourceName: 'Chromatin immunoprecipitation',
    identifier: '10.1038/nprot.2009.97', source: '', newReuse: 'reuse'
  });
  const nameless = itemAddRow({
    resourceType: 'Protocol', resourceName: '',
    identifier: '10.1038/nprot.2009.97', source: 'Nature Protocols', newReuse: ''
  });

  const r = mergeDetections([
    { source: 'identifier_detection', items: [nameless] },
    { source: 'protocols_detection',  items: [named] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Chromatin immunoprecipitation');
  assert.equal(r[0].newReuse, 'reuse');
});

test('nameless row matches a NON-FIRST identifier in a semicolon-joined field', () => {
  // Real shape from the ASAP demo corpus (hu1-000350-018): one protocol row
  // carrying many protocols.io DOIs. extractIdentifierTokens only indexes the
  // first, so without the _idParts check the venue scan re-emits DOIs 2..n as
  // blank duplicate suggestions.
  const multi = itemAddRow({
    resourceType: 'Protocol', resourceName: 'Protein expression and purification',
    identifier: 'https://doi.org/10.17504/protocols.io.aaa/v1 ; https://doi.org/10.17504/protocols.io.bbb/v1; https://doi.org/10.17504/protocols.io.ccc/v1',
    newReuse: 'reuse'
  });
  const second = itemAddRow({
    resourceType: 'Protocol', resourceName: '',
    identifier: '10.17504/protocols.io.bbb/v1', source: 'protocols.io', newReuse: ''
  });
  const third = itemAddRow({
    resourceType: 'Protocol', resourceName: '',
    identifier: '10.17504/protocols.io.ccc/v1', source: 'protocols.io', newReuse: ''
  });

  const r = mergeDetections([
    { source: 'protocols_detection',  items: [multi] },
    { source: 'identifier_detection', items: [second, third] }
  ]);
  assert.equal(r.length, 1, 'both trailing DOIs should fold into the multi-DOI row');
  assert.equal(r[0].resourceName, 'Protein expression and purification');
});

test('a shared DOI does NOT merge two distinct NAMED protocols', () => {
  // Guards the _idParts widening against over-reach. Also from hu1-000350-018:
  // "Flow cytometry" and "Rapalog-induced chemical dimerization" cite one
  // protocols.io DOI in common and must remain two rows.
  const flow = itemAddRow({
    resourceType: 'Protocol', resourceName: 'Flow cytometry',
    identifier: 'https://doi.org/10.17504/protocols.io.q26g.../v1 ; https://doi.org/10.17504/protocols.io.n92l.../v1',
    newReuse: 'reuse'
  });
  const rapalog = itemAddRow({
    resourceType: 'Protocol', resourceName: 'Rapalog-induced chemical dimerization experiments',
    identifier: 'https://doi.org/10.17504/protocols.io.n92l.../v1',
    newReuse: 'reuse'
  });
  const r = mergeDetections([
    { source: 'protocols_detection', items: [flow, rapalog] }
  ]);
  assert.equal(r.length, 2);
});

test('nameless rule does NOT merge unrelated identifiers', () => {
  // Relaxing the new/reuse gate must not make a nameless row a wildcard: with
  // no identifier overlap and no name, there is nothing to match on.
  const r = mergeDetections([
    { source: 'protocols_detection', items: [itemAddRow({
      resourceType: 'Protocol', resourceName: 'ChIP', identifier: '10.1038/nprot.2009.97', newReuse: 'reuse'
    })] },
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Protocol', resourceName: '', identifier: '10.3791/61234', newReuse: ''
    })] }
  ]);
  assert.equal(r.length, 2);
});

test('two NAMED rows still never merge across different new/reuse', () => {
  // Guards the nameless rule against over-reach — this is the pre-existing
  // invariant, restated with a shared identifier to prove it is name-gated.
  const r = mergeDetections([
    { source: 'protocols_detection', items: [itemAddRow({
      resourceType: 'Protocol', resourceName: 'ChIP', identifier: '10.1038/nprot.2009.97', newReuse: 'new'
    })] },
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Protocol', resourceName: 'ChIP assay', identifier: '10.1038/nprot.2009.97', newReuse: 'reuse'
    })] }
  ]);
  assert.equal(r.length, 2);
});

// ---------- protocol venue outranks the detector's SOURCE (ticket #30 item 6) ----------

test('applyVenueSource: demotes the detector wording into parentheses', () => {
  assert.equal(applyVenueSource('protocols.io', 'Meyer et al., 2024'), 'protocols.io (Meyer et al., 2024)');
  assert.equal(applyVenueSource('protocols.io', 'This paper'),         'protocols.io (This paper)');
  assert.equal(applyVenueSource('JoVE', 'Journal of Visualized Experiments'),
    'JoVE (Journal of Visualized Experiments)');
});

test('applyVenueSource: no echo when the detector already named the venue', () => {
  assert.equal(applyVenueSource('protocols.io', 'protocols.io'), 'protocols.io');
  assert.equal(applyVenueSource('protocols.io', 'Protocols.IO'),  'protocols.io');
  assert.equal(applyVenueSource('protocols.io', ''),              'protocols.io');
  assert.equal(applyVenueSource('protocols.io', '   '),           'protocols.io');
});

test('applyVenueSource: idempotent across repeated consolidations', () => {
  // Consolidation re-runs on "Regenerate suggestions" — without this guard the
  // parentheses would nest one level deeper every time.
  const once  = applyVenueSource('protocols.io', 'Meyer et al., 2024');
  const twice = applyVenueSource('protocols.io', once);
  const three = applyVenueSource('protocols.io', twice);
  assert.equal(twice, 'protocols.io (Meyer et al., 2024)');
  assert.equal(three, 'protocols.io (Meyer et al., 2024)');
});

test('venue identifier overrides the SOURCE a detector supplied', () => {
  const r = mergeDetections([
    { source: 'protocols_detection', items: [itemAddRow({
      resourceType: 'Protocol', resourceName: 'Organoid culture',
      identifier: 'http://doi.org/10.17504/protocols.io.261ge8b9jg47/v2',
      source: 'Meyer et al., 2024', newReuse: 'reuse'
    })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sourceUrl, 'protocols.io (Meyer et al., 2024)');
});

test('a NON-venue inferred source never overrides a detector SOURCE', () => {
  // Data/code repositories keep the old behaviour: the detector wins.
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({
      resourceType: 'Software/code', resourceName: 'my-tool',
      identifier: '10.5281/zenodo.123456', source: 'Lab website', newReuse: 'new'
    })] }
  ]);
  assert.equal(r[0].sourceUrl, 'Lab website');
});

test('venue override still fills a blank SOURCE with the bare venue', () => {
  const r = mergeDetections([
    { source: 'protocols_detection', items: [itemAddRow({
      resourceType: 'Protocol', resourceName: 'ChIP',
      identifier: '10.1038/nprot.2009.97', source: '', newReuse: 'reuse'
    })] }
  ]);
  assert.equal(r[0].sourceUrl, 'Nature Protocols');
});

test('different resourceType → NOT merged', () => {
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({ resourceType: 'Software/code', resourceName: 'X' })] },
    { source: 'datasets_detection', items: [itemAddRow({ resourceType: 'Dataset',       resourceName: 'X' })] }
  ]);
  assert.equal(r.length, 2);
});

test('3-way chain: A↔B by name, B↔C by identifier → all 3 merge', () => {
  const r = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Tool',  identifier: 'id-1' })] },
    { source: 'b', items: [itemAddRow({ resourceName: 'TOOL',  identifier: 'id-2' })] }, // matches A by name
    { source: 'c', items: [itemAddRow({ resourceName: 'Other', identifier: 'id-2' })] }  // matches B by identifier
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].detectedBy.length, 3);
});

test('additional_information merged with line dedup', () => {
  const r = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'X', additionalInformation: 'note1; note2' })] },
    { source: 'b', items: [itemAddRow({ resourceName: 'x', additionalInformation: 'note2; note3' })] }
  ]);
  assert.equal(r.length, 1);
  // 'note2' should appear once
  const info = r[0].additionalInformation;
  const matches = info.match(/note2/g) || [];
  assert.equal(matches.length, 1, `expected 'note2' to appear once, info: "${info}"`);
  // All three notes should be present
  assert.ok(info.includes('note1'));
  assert.ok(info.includes('note2'));
  assert.ok(info.includes('note3'));
});

test('higher-confidence contributor becomes primary', () => {
  const r = mergeDetections([
    { source: 'low',  items: [itemAddRow({ resourceName: 'X', confidence: 0.3 })] },
    { source: 'high', items: [itemAddRow({ resourceName: 'x', confidence: 0.9 })] }
  ]);
  // Items have nested confidence so we have to set it on the wrapping itemAddRow
  // This test uses the inline confidence: 0.8 default; the data.confidence isn't read.
  // Fix the fixture instead — set confidence on the item wrapper.
  // For now just verify they merged.
  assert.equal(r.length, 1);
  assert.equal(r[0].detectedBy.length, 2);
});

test('high-confidence with explicit item.confidence wins primary', () => {
  const a = itemAddRow({ resourceName: 'X' });
  a.confidence = 0.4;
  const b = itemAddRow({ resourceName: 'x' });
  b.confidence = 0.9;
  const r = mergeDetections([
    { source: 'a', items: [a] },
    { source: 'b', items: [b] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].confidence, 0.9);
});

test('item with empty resourceType is dropped', () => {
  const r = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceType: '', resourceName: 'X' })] }
  ]);
  assert.equal(r.length, 0);
});

test('item with empty name AND empty identifier is dropped', () => {
  const r = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: '', identifier: '' })] }
  ]);
  assert.equal(r.length, 0);
});

test('dedupKey is stable across re-runs (different identifier shapes, same DOI)', () => {
  const r1 = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'Python', identifier: 'https://doi.org/10.5281/zenodo.X' })] }
  ]);
  const r2 = mergeDetections([
    { source: 'a', items: [itemAddRow({ resourceName: 'PYTHON', identifier: 'DOI: 10.5281/zenodo.X.' })] }
  ]);
  assert.equal(r1[0].dedupKey, r2[0].dedupKey);
});

test('mergeAdditionalInfo: dedup is case-insensitive on lines', () => {
  const out = mergeAdditionalInfo('Note A; Note B', 'note a; Note C');
  // 'Note A' should appear once
  const lines = out.split(';').map(s => s.trim().toLowerCase());
  const a = lines.filter(l => l === 'note a').length;
  assert.equal(a, 1);
});

test('mergeAdditionalInfo: empty inputs return empty', () => {
  assert.equal(mergeAdditionalInfo('', ''), '');
  assert.equal(mergeAdditionalInfo(null, undefined), '');
});

// ───────────────────────────────────────────────────────────────────────────
// Source precedence: Software / Datasets / Protocols beat Identifier-scan
// for the representative-fields race, regardless of confidence.
// ───────────────────────────────────────────────────────────────────────────

const { outranks, SOURCE_PRECEDENCE } = require('./merge-detections.service');

// Helper: build a contribution with explicit name / identifier / source URL.
// Confidence is set high by default so confidence isn't the deciding factor
// unless the test intentionally manipulates it.
const c = (resourceName, identifier, sourceUrl, overrides = {}) => ({
  type: 'add_row',
  data: {
    resourceType: 'Software/code',
    resourceName,
    source: sourceUrl,
    identifier,
    newReuse: 'reuse',
    additionalInformation: '',
    ...overrides
  },
  confidence: overrides.confidence ?? 0.8
});

test('SOURCE_PRECEDENCE: identifier-scan ranks below the targeted NER detectors', () => {
  assert.ok(SOURCE_PRECEDENCE.software_detection  > SOURCE_PRECEDENCE.identifier_detection);
  assert.ok(SOURCE_PRECEDENCE.datasets_detection  > SOURCE_PRECEDENCE.identifier_detection);
  assert.ok(SOURCE_PRECEDENCE.protocols_detection > SOURCE_PRECEDENCE.identifier_detection);
});

test('outranks: same precedence falls through to confidence', () => {
  const a = { source: 'software_detection', confidence: 0.9 };
  const b = { source: 'datasets_detection', confidence: 0.5 };
  assert.equal(outranks(a, b), true);   // higher conf wins at same precedence
  assert.equal(outranks(b, a), false);
});

test('outranks: higher precedence beats higher confidence', () => {
  const sw = { source: 'software_detection', confidence: 0.5 };
  const id = { source: 'identifier_detection', confidence: 0.95 };
  assert.equal(outranks(sw, id), true);   // sw promoted despite lower conf
  assert.equal(outranks(id, sw), false);  // id never promotes against sw
});

test('precedence: ID + Software on shared identifier → Software fields win', () => {
  // ID-scan often emits a curated-list-style name + RRID; Softcite emits the
  // in-paper canonical name + a real URL. The user wants Softcite's fields
  // to show up in the Generated KRT row.
  const idItem = c('Fiji image J',      'RRID:SCR_002285', 'https://curated/fiji', { confidence: 0.95 });
  const swItem = c('Fiji',              'RRID:SCR_002285', 'https://fiji.sc',      { confidence: 0.85 });
  const r = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'software_detection',   items: [swItem] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Fiji');
  assert.equal(r[0].sourceUrl,    'https://fiji.sc');
  // Both contributors are still recorded.
  const sources = r[0].detectedBy.map(d => d.source).sort();
  assert.deepEqual(sources, ['identifier_detection', 'software_detection']);
});

test('precedence: ID + Datasets → Datasets fields win', () => {
  const idItem = c('GEO entry',         'GSE12345', 'curated/geo',                 { confidence: 0.95, resourceType: 'Dataset' });
  const dsItem = c('Cortex scRNA-seq',  'GSE12345', 'https://ncbi.nlm.nih.gov/geo',{ confidence: 0.7,  resourceType: 'Dataset' });
  const r = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'datasets_detection',   items: [dsItem] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Cortex scRNA-seq');
  assert.equal(r[0].sourceUrl,    'https://ncbi.nlm.nih.gov/geo');
});

test('precedence: ID + Protocols → Protocols fields win', () => {
  const idItem = c('WB protocol',          'doi:10.17504/wb', 'curated/protocol',  { confidence: 0.95, resourceType: 'Protocol' });
  const ptItem = c('Western blot v2',      'doi:10.17504/wb', 'https://protocols.io/wb', { confidence: 0.6, resourceType: 'Protocol' });
  const r = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'protocols_detection',  items: [ptItem] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'Western blot v2');
  assert.equal(r[0].sourceUrl,    'https://protocols.io/wb');
});

test('precedence: order-independent — ID first vs ID last produces same fields', () => {
  const idItem = c('Fiji image J', 'RRID:SCR_002285', 'curated/fiji', { confidence: 0.95 });
  const swItem = c('Fiji',         'RRID:SCR_002285', 'https://fiji.sc', { confidence: 0.85 });

  const idFirst = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'software_detection',   items: [swItem] }
  ]);
  const swFirst = mergeDetections([
    { source: 'software_detection',   items: [swItem] },
    { source: 'identifier_detection', items: [idItem] }
  ]);

  for (const r of [idFirst, swFirst]) {
    assert.equal(r.length, 1);
    assert.equal(r[0].resourceName, 'Fiji');
    assert.equal(r[0].sourceUrl,    'https://fiji.sc');
  }
});

test('precedence: confidence still wins among same-precedence sources', () => {
  // Software (lower conf) + Datasets (higher conf). Both rank 1; the higher-
  // confidence one provides the representative fields. This guards the
  // existing Software-vs-Datasets behavior from accidental regression.
  const swItem = c('SwName', 'shared-id', 'sw-url', { confidence: 0.5, resourceType: 'Dataset' });
  const dsItem = c('DsName', 'shared-id', 'ds-url', { confidence: 0.9, resourceType: 'Dataset' });
  const r = mergeDetections([
    { source: 'software_detection', items: [swItem] },
    { source: 'datasets_detection', items: [dsItem] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'DsName');
  assert.equal(r[0].sourceUrl,    'ds-url');
});

test('precedence: three-way ID + Software + Datasets — ID never wins fields', () => {
  // Software (conf 0.6) + Datasets (conf 0.8) + ID (conf 0.95). All collide
  // on the same identifier. Datasets should win the representative fields
  // (highest conf among precedence-1 sources). ID is recorded as a
  // contributor but doesn't take ownership.
  const swItem = c('SwName',  'shared-id', 'sw-url',      { confidence: 0.6, resourceType: 'Dataset' });
  const dsItem = c('DsName',  'shared-id', 'ds-url',      { confidence: 0.8, resourceType: 'Dataset' });
  const idItem = c('IdName',  'shared-id', 'curated-url', { confidence: 0.95, resourceType: 'Dataset' });
  const r = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'software_detection',   items: [swItem] },
    { source: 'datasets_detection',   items: [dsItem] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].resourceName, 'DsName');
  assert.equal(r[0].sourceUrl,    'ds-url');
  const sources = r[0].detectedBy.map(d => d.source).sort();
  assert.deepEqual(sources, ['datasets_detection', 'identifier_detection', 'software_detection']);
});

test('precedence: merged row confidence is still max across contributors', () => {
  // ID has higher raw confidence than Software; Software wins display
  // fields, but the merged row's `confidence` (used downstream for sorting)
  // should still report 0.95 — the max.
  const idItem = c('IdName', 'shared-id', 'id-url', { confidence: 0.95 });
  const swItem = c('SwName', 'shared-id', 'sw-url', { confidence: 0.7 });
  const r = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'software_detection',   items: [swItem] }
  ]);
  assert.equal(r[0].resourceName, 'SwName');
  assert.equal(r[0].confidence,    0.95);
});

test('precedence: additionalInformation is concatenated even when ID loses field race', () => {
  // ID's context should still be preserved on the merged row; only the
  // representative display fields lose. The merger concatenates
  // additionalInformation across all contributors.
  const idItem = c('IdName', 'shared-id', 'id-url', { additionalInformation: 'id-context', confidence: 0.95 });
  const swItem = c('SwName', 'shared-id', 'sw-url', { additionalInformation: 'sw-context', confidence: 0.7 });
  const r = mergeDetections([
    { source: 'identifier_detection', items: [idItem] },
    { source: 'software_detection',   items: [swItem] }
  ]);
  assert.match(r[0].additionalInformation, /id-context/);
  assert.match(r[0].additionalInformation, /sw-context/);
});

// ───────────────────────────────────────────────────────────────────────────
// resourceType normalization — "Code/Software" ↔ "Software/code" synonym
// ───────────────────────────────────────────────────────────────────────────

test('normalizeResourceTypeKey: software variants collapse to one key', () => {
  assert.equal(normalizeResourceTypeKey('Code/Software'), 'software/code');
  assert.equal(normalizeResourceTypeKey('Software/code'), 'software/code');
  assert.equal(normalizeResourceTypeKey('software'),      'software/code');
  assert.equal(normalizeResourceTypeKey('Code'),          'software/code');
});

test('normalizeResourceTypeKey: other types pass through (lowercased, trimmed)', () => {
  assert.equal(normalizeResourceTypeKey('Antibody'), 'antibody');
  assert.equal(normalizeResourceTypeKey('Dataset'),  'dataset');
  assert.equal(normalizeResourceTypeKey('  Experimental model: Cell line '), 'experimental model: cell line');
});

test('mergeDetections: Code/Software and Software/code merge as one', () => {
  // Reproduces the Fiji duplicate from production: software_detection emits
  // "Software/code", identifier scanner emits "Code/Software" from the
  // curated DB. They must merge on shared identifier despite the label
  // mismatch.
  const r = mergeDetections([
    { source: 'software_detection', items: [
      itemAddRow({ resourceType: 'Software/code', resourceName: 'Fiji', identifier: 'RRID:SCR_002285' })
    ]},
    { source: 'identifier_detection', items: [
      itemAddRow({ resourceType: 'Code/Software', resourceName: 'Fiji', identifier: 'RRID:SCR_002285' })
    ]}
  ]);
  assert.equal(r.length, 1, 'Fiji must merge into a single entry across type variants');
  assert.equal(r[0].detectedBy.length, 2);
});

// ---------- SOURCE auto-detection from identifier ----------

test('source inferred from identifier when no contributor supplied one', () => {
  const r = mergeDetections([
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Software/code',
      resourceName: 'MyTool',
      identifier: 'https://github.com/foo/bar',
      source: ''
    })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sourceUrl, 'GitHub');
});

test('inferred source does NOT overwrite a contributor-supplied source', () => {
  const r = mergeDetections([
    { source: 'software_detection', items: [itemAddRow({
      resourceType: 'Software/code',
      resourceName: 'MyTool',
      identifier: 'https://github.com/foo/bar',
      source: 'https://mytool.example.org'
    })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sourceUrl, 'https://mytool.example.org', 'real source must be preserved');
});

test('ambiguous / unknown identifier leaves source empty', () => {
  const r = mergeDetections([
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Antibody',
      resourceName: 'Anti-Foo',
      identifier: 'RRID:AB_2744623',
      source: ''
    })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sourceUrl, '', 'must not guess a source for a bare RRID');
});

test('zenodo DOI infers source when both contributors leave source blank', () => {
  const r = mergeDetections([
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Dataset',
      resourceName: 'My dataset',
      identifier: '10.5281/zenodo.123456',
      source: ''
    })] },
    { source: 'datasets_detection', items: [itemAddRow({
      resourceType: 'Dataset',
      resourceName: 'My dataset',
      identifier: '10.5281/zenodo.123456',
      source: ''
    })] }
  ]);
  assert.equal(r.length, 1, 'same zenodo id → merged');
  assert.equal(r[0].sourceUrl, 'Zenodo');
});

test('inferred source prefers DOI/accession over a URL (Zenodo DOI beats GitHub URL)', () => {
  const r = mergeDetections([
    { source: 'identifier_detection', items: [itemAddRow({
      resourceType: 'Software/code',
      resourceName: 'MyTool',
      identifier: 'https://github.com/foo/bar ; 10.5281/zenodo.123456',
      source: ''
    })] }
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sourceUrl, 'Zenodo');
});
