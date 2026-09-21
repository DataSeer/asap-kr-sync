/**
 * The corrections we are certain of, on the rows that provoked them.
 *
 * Every case below is a real candidate from the two manuscripts the ASAP PM
 * tested in September 2026 (submissions PM-708014 / PM-Parkin, local run
 * 2026-09-21). The point of the rules is not tidiness: a protocol typed as
 * software cannot merge with the protocol row for the same DOI, so the author
 * is asked to add their own protocol to their KRT as a piece of code.
 *
 * What must NOT be curated matters as much — a rule that eats a real resource
 * is worse than the row it was meant to remove, so each rule has a case
 * proving where it stops.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { curateCandidates, curateOne, isLabMadeSolution, DEFAULT_CURATION_POLICY } = require('./curate-candidates.service');
const { dedupeKrtItems } = require('./dedupe-krt-items.service');

/** A software candidate, so each case can change exactly one thing. */
const sw = (over = {}) => ({
  resourceType: 'Software/code',
  resourceName: 'Fiji',
  identifier: 'RRID:SCR_002285',
  source: 'https://imagej.net/software/fiji/',
  newReuse: 'reuse',
  origin: 'software-lm',
  confidence: 0.8,
  additionalInformation: '',
  ...over
});

const only = (items, origin) => curateCandidates(items, origin);
const types = (items) => items.map(i => i.resourceType);
const names = (items) => items.map(i => i.resourceName);

// ─────────────────────────────────────────────────────────────────────────────
// 1. A protocol-venue identifier is a protocol
// ─────────────────────────────────────────────────────────────────────────────

test('a protocols.io DOI retypes a software row to Protocol', () => {
  const { items, curationLog } = only([
    sw({ resourceName: 'Custom IP and Input proteomic preparation protocol', identifier: 'dx.doi.org/10.17504/protocols.io.3byl4wrj8vo5/v1', source: 'protocols.io' })
  ], 'software-lm');
  assert.deepEqual(types(items), ['Protocol']);
  assert.equal(curationLog[0].rule, 'protocol-venue-identifier');
  assert.equal(curationLog[0].origin, 'software-lm');
});

test('the FIJI macro and the CellProfiler pipeline follow their protocols.io record', () => {
  // The authors of both manuscripts filed exactly these as Protocol rows in
  // their own KRT, and listed FIJI / CellProfiler separately with RRIDs.
  const { items } = only([
    sw({ resourceName: 'Custom FIJI macro', identifier: 'dx.doi.org/10.17504/protocols.io.5jyl8xjzdv2w/v1', source: 'protocols.io' }),
    sw({ resourceName: 'CellProfiler pipeline', identifier: 'dx.doi.org/10.17504/protocols.io.261ge13bwv47/v2', source: 'protocols.io' })
  ]);
  assert.deepEqual(types(items), ['Protocol', 'Protocol']);
});

test('a protocols.io /view/ URL counts as the record too', () => {
  const { items } = only([
    sw({ resourceName: 'Custom DNA extraction and mtDNA analysis protocol', identifier: 'https://www.protocols.io/view/dna-extraction-and-mtdna-analysis-from-mouse-tissukxygxrp44g8j/v1', source: 'protocols.io' })
  ]);
  assert.deepEqual(types(items), ['Protocol']);
});

test('the tools themselves keep their type — only the protocol record moves', () => {
  const { items, curationLog } = only([
    sw(),                                                   // Fiji, RRID
    sw({ resourceName: 'CellProfiler', identifier: 'RRID:SCR_007358', source: 'PMID: 34507520' }),
    sw({ resourceName: 'R scripts', identifier: 'https://doi.org/10.5061/dryad.4xgxd25r0', source: 'Dryad' })
  ]);
  assert.deepEqual(types(items), ['Software/code', 'Software/code', 'Software/code']);
  assert.equal(curationLog.length, 0, 'a Dryad DOI is a dataset deposit, not a protocol venue');
});

test('a row already typed Protocol is left alone', () => {
  const { curationLog } = only([
    { resourceType: 'Protocol', resourceName: 'LysoIP immunoprecipitation from tissue', identifier: '10.17504/protocols.io.5qpvo98rdv4o/v1', source: 'protocols.io', newReuse: 'reuse' }
  ]);
  assert.equal(curationLog.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The platform is not a resource
// ─────────────────────────────────────────────────────────────────────────────

test('"protocols.io" pointing at its own home page is dropped', () => {
  // The Parkin paper ends with "all methods used are available in protocols.io
  // or similar"; the software pass turned the sentence into a tool.
  const { items, curationLog } = only([
    sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io', source: 'https://www.protocols.io' })
  ]);
  assert.deepEqual(items, []);
  assert.equal(curationLog[0].rule, 'platform-not-a-resource');
});

test('a platform row with a record identifier is kept (and retyped when it is a protocol)', () => {
  const { items } = only([
    sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io/view/some-real-record/v1' })
  ]);
  assert.deepEqual(types(items), ['Protocol']);
});

test('GitHub and Zenodo as bare names go too, but a repository URL stays', () => {
  const { items } = only([
    sw({ resourceName: 'GitHub', identifier: 'https://github.com', source: 'GitHub' }),
    sw({ resourceName: 'Zenodo', identifier: '', source: '' }),
    sw({ resourceName: 'my-analysis-pipeline', identifier: 'https://github.com/lab/my-analysis-pipeline', source: 'GitHub' })
  ]);
  assert.deepEqual(names(items), ['my-analysis-pipeline']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Kits and instruments are not software
// ─────────────────────────────────────────────────────────────────────────────

test('kits detected as software become Critical commercial assay', () => {
  const { items, curationLog } = only([
    sw({ resourceName: 'DNeasy Blood and Tissue kit', identifier: '', source: 'Qiagen' }),
    sw({ resourceName: 'microBCA assay kit', identifier: '', source: '' }),
    sw({ resourceName: 'RNAscope Multiplex Fluorescent Detection Kit v2', identifier: '#323100', source: 'Advanced Cell Diagnostics' })
  ]);
  assert.deepEqual(types(items), ['Critical commercial assay', 'Critical commercial assay', 'Critical commercial assay']);
  assert.equal(curationLog.every(a => a.rule === 'kit-is-not-software'), true);
});

test('instruments and their acquisition software become Other', () => {
  const { items } = only([
    sw({ resourceName: 'Li-COR Odyssey CLx scanning imaging system', identifier: '', source: 'Li-COR' }),
    sw({ resourceName: 'ChemiDoc MP Imaging system', identifier: '', source: 'BioRad Laboratories' }),
    sw({ resourceName: 'Orbitrap Exploris 480 Mass Spectrometer', identifier: '', source: 'Thermo' }),
    sw({ resourceName: 'SpeedVac Vacuum Concentrator', identifier: '', source: '' }),
    sw({ resourceName: 'Zeiss LSM 900 confocal microscope', identifier: '', source: 'Zeiss' })
  ]);
  assert.deepEqual(types(items), ['Other', 'Other', 'Other', 'Other', 'Other']);
});

test('a tool whose name merely contains a kit-ish word is not retyped', () => {
  // "Toolkit" is one word, and the rule anchors on the end of the name.
  const { items, curationLog } = only([
    sw({ resourceName: 'Genome Analysis Toolkit', identifier: 'RRID:SCR_001876' }),
    sw({ resourceName: 'Image Studio Software', identifier: '', source: 'Li-COR' })
  ]);
  assert.deepEqual(types(items), ['Software/code', 'Software/code']);
  assert.equal(curationLog.length, 0);
});

test('a kit row from the materials detector is not touched by the software rule', () => {
  const { curationLog } = only([
    { resourceType: 'Critical commercial assay', resourceName: 'DNeasy Blood and Tissue kit', identifier: '', source: 'Qiagen', newReuse: 'reuse' }
  ]);
  assert.equal(curationLog.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Solutions mixed at the bench, with nothing to order them by
// ─────────────────────────────────────────────────────────────────────────────

const chem = (name, over = {}) => ({
  resourceType: 'Chemical, peptide, or recombinant protein',
  resourceName: name, identifier: '', source: '', newReuse: 'reuse', origin: 'materials-gemini', ...over
});

test('recipes and generic buffers with no source and no identifier are dropped', () => {
  const { items, curationLog } = only([
    chem('4% paraformaldehyde (PFA) in PBS'),
    chem('30% (w/v) sucrose in PBS'),
    chem('0.1% Triton X-100 in PBS'),
    chem('PBS containing 2% FBS and 1% BSA'),
    chem('Tris-buffered saline with 0.1% Tween (TBST)'),
    chem('KPBS buffer'),
    chem('lysis buffer'),
    chem('milk')
  ]);
  assert.deepEqual(items, []);
  assert.equal(curationLog.every(a => a.rule === 'lab-made-solution'), true);
});

test('the same buffer with a supplier or a catalog number is kept', () => {
  const { items, curationLog } = only([
    chem('PBS', { source: 'Gibco', identifier: '10010023' }),
    chem('TBST', { source: 'Sigma' }),
    chem('lysis buffer', { identifier: '9803' })
  ]);
  assert.equal(items.length, 3);
  assert.equal(curationLog.length, 0);
});

test('real reagents are never mistaken for bench solutions', () => {
  const { items } = only([
    chem('cOmplete EDTA-free protease inhibitor cocktail', { source: 'Roche', identifier: '11873580001' }),
    chem('Microcystin-LR', { source: 'Sigma', identifier: '475815-M' }),
    chem('Oligomycin', { source: 'Sigma-Aldrich' }),
    chem('4-hydroxytamoxifen')
  ]);
  assert.equal(items.length, 4);
});

test('isLabMadeSolution draws the line on the name alone', () => {
  for (const yes of ['PBS', '1x PBS', 'TBS-T', 'TBST', 'milk', 'lysis buffer', '4% PFA in PBS', 'PBS containing 2% FBS']) {
    assert.equal(isLabMadeSolution(yes), true, `${yes} should read as bench-made`);
  }
  for (const no of ['Oligomycin', 'PBS-based antibody diluent kit from Vendor X', 'Bond-Breaker TCEP Solution, Neutral pH', 'anti-tubulin antibody', '']) {
    assert.equal(isLabMadeSolution(no), false, `${no} should NOT read as bench-made`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape and integration
// ─────────────────────────────────────────────────────────────────────────────

test('curation never mutates its input', () => {
  const input = [sw({ resourceName: 'Custom FIJI macro', identifier: '10.17504/protocols.io.5jyl8xjzdv2w/v1' })];
  const before = JSON.parse(JSON.stringify(input));
  curateCandidates(input);
  assert.deepEqual(input, before);
});

test('everything else passes through untouched, with an empty log', () => {
  const input = [sw(), { resourceType: 'Dataset', resourceName: 'Raw images', identifier: 'https://zenodo.org/records/1', source: 'Zenodo', newReuse: 'new' }];
  const { items, curationLog } = curateCandidates(input);
  assert.deepEqual(items, input);
  assert.deepEqual(curationLog, []);
});

test('curateOne reports a verdict for a single item', () => {
  const { item, action } = curateOne(sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io' }));
  assert.equal(item, null);
  assert.equal(action.outcome, 'dropped');
});

test('empty, junk and missing input are answered, not thrown at', () => {
  assert.deepEqual(curateCandidates([]), { items: [], curationLog: [] });
  assert.deepEqual(curateCandidates(), { items: [], curationLog: [] });
  assert.deepEqual(curateCandidates([null, undefined, 'nope']).items, []);
});

test('dedupeKrtItems curates before merging, and reports what it did', () => {
  // The whole point: retyped to Protocol, the software row now merges with the
  // protocol row carrying the same DOI instead of surviving beside it.
  const curationLog = [];
  const out = dedupeKrtItems([
    sw({ resourceName: 'Custom IP and Input proteomic preparation protocol', identifier: '10.17504/protocols.io.3byl4wrj8vo5/v1', source: 'protocols.io' }),
    { resourceType: 'Protocol', resourceName: 'Proteomics sample preparation', identifier: '10.17504/protocols.io.3byl4wrj8vo5/v1', source: 'protocols.io', newReuse: 'reuse', origin: 'protocols-gemini', confidence: 0.9 },
    sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io' })
  ], 'test-detector', { curationLog });

  assert.deepEqual(types(out), ['Protocol'], 'one protocol, not a protocol plus a rival software row');
  assert.equal(out[0].mergedFrom.length, 2, 'both detectors are recorded as contributors');
  assert.deepEqual(curationLog.map(a => a.rule), ['protocol-venue-identifier', 'platform-not-a-resource']);
});

test('dedupeKrtItems still answers an empty list after curation removes everything', () => {
  assert.deepEqual(dedupeKrtItems([sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io' })], 'test'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Policy — a rule ASAP disagrees with can be turned off per pipeline
// ─────────────────────────────────────────────────────────────────────────────

test('a rule turned off in the pipeline policy does not fire', () => {
  const input = [
    sw({ resourceName: 'Custom FIJI macro', identifier: '10.17504/protocols.io.5jyl8xjzdv2w/v1' }),
    sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io' }),
    sw({ resourceName: 'DNeasy Blood and Tissue kit', identifier: '', source: 'Qiagen' })
  ];
  const off = curateCandidates(input, 'software-lm', { protocolVenue: false, platforms: false });
  assert.deepEqual(types(off.items), ['Software/code', 'Software/code', 'Critical commercial assay']);
  assert.deepEqual(off.curationLog.map(a => a.rule), ['kit-is-not-software']);
});

test('an absent or partial policy still runs every other rule', () => {
  const input = [sw({ resourceName: 'protocols.io', identifier: 'https://www.protocols.io' })];
  for (const policy of [undefined, null, {}, 'nonsense', { kits: false }]) {
    assert.deepEqual(curateCandidates(input, '', policy).items, [], `policy ${JSON.stringify(policy)}`);
  }
});

test('the default policy is every rule', () => {
  assert.deepEqual(DEFAULT_CURATION_POLICY, {
    protocolVenue: true, platforms: true, kits: true, instruments: true, labSolutions: true
  });
});
