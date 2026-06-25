/**
 * Tests for the software pipeline steps.
 *
 * detectSoftware hits the Softcite API and is exercised via integration.
 * Here we test buildKrtItemsSoftware (and the dedupe of its output) in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildKrtItemsSoftware,
  applySoftwarePolicy,
  isInstrumentSoftware,
  detectCodeLanguage
} = require('./software.service');
const { dedupeKrtItems } = require('../pdf-analysis/dedupe-krt-items.service');

test('buildKrtItemsSoftware: empty / non-array → []', () => {
  assert.deepEqual(buildKrtItemsSoftware([]), []);
  assert.deepEqual(buildKrtItemsSoftware(null), []);
});

test('buildKrtItemsSoftware: Softcite-shape → canonical KrtEntry', () => {
  const raw = [{
    name: 'MATLAB R2019b',
    normalizedName: 'MATLAB',
    url: 'https://mathworks.com',
    version: 'R2019b',
    creator: 'MathWorks',
    confidence: 0.9,
    context: 'Statistics computed in MATLAB R2019b.'
  }];
  const items = buildKrtItemsSoftware(raw);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.resourceType, 'Software/code');
  // Normalized name wins for the canonical resourceName
  assert.equal(item.resourceName, 'MATLAB');
  assert.equal(item.source, 'https://mathworks.com');
  assert.equal(item.confidence, 0.9);
  assert.equal(item.origin, 'softcite');
  // Per ASAP request: do NOT push the detector context blurb into the
  // user-facing ADDITIONAL INFORMATION cell. It lives on detectorMeta.
  assert.equal(item.additionalInformation, '');
  assert.equal(item.detectorMeta.softciteName, 'MATLAB R2019b');
  assert.equal(item.detectorMeta.normalizedName, 'MATLAB');
  assert.equal(item.detectorMeta.version, 'R2019b');
  assert.equal(item.detectorMeta.context, 'Statistics computed in MATLAB R2019b.');
});

test('buildKrtItemsSoftware: missing confidence → default', () => {
  const items = buildKrtItemsSoftware([{ name: 'Python' }]);
  assert.equal(items[0].confidence, 0.7);
});

test('buildKrtItemsSoftware: falls back to `name` when normalizedName is missing', () => {
  const items = buildKrtItemsSoftware([{ name: 'GraphPad Prism' }]);
  assert.equal(items[0].resourceName, 'GraphPad Prism');
});

// ── Software policy (requests B1/B3/B4) ──────────────────────────────────────

test('detectCodeLanguage: known languages → canonical label; others → null', () => {
  assert.equal(detectCodeLanguage('r'), 'R');
  assert.equal(detectCodeLanguage('MATLAB'), 'MATLAB');
  assert.equal(detectCodeLanguage('python'), 'Python');
  assert.equal(detectCodeLanguage('Fiji'), null);
  assert.equal(detectCodeLanguage(''), null);
});

test('isInstrumentSoftware: flags acquisition software, not analysis tools', () => {
  assert.equal(isInstrumentSoftware('ZEN'), true);
  assert.equal(isInstrumentSoftware('NIS-Elements'), true);
  assert.equal(isInstrumentSoftware('LAS X'), true);
  assert.equal(isInstrumentSoftware('Fiji'), false);
  assert.equal(isInstrumentSoftware('GraphPad Prism'), false);
});

test('applySoftwarePolicy: B1 software defaults to reuse', () => {
  const out = applySoftwarePolicy(buildKrtItemsSoftware([{ name: 'Fiji' }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].resourceName, 'Fiji');
  assert.equal(out[0].newReuse, 'reuse');
});

test('applySoftwarePolicy: B4 language → "<Lang> code" marked new', () => {
  const out = applySoftwarePolicy(buildKrtItemsSoftware([
    { name: 'MATLAB R2019b', normalizedName: 'MATLAB' }
  ]));
  assert.equal(out[0].resourceName, 'MATLAB code');
  assert.equal(out[0].newReuse, 'new');
  assert.equal(out[0].detectorMeta.codeLanguage, 'MATLAB');
});

test('applySoftwarePolicy: B3 instrument software is dropped', () => {
  const out = applySoftwarePolicy(buildKrtItemsSoftware([
    { name: 'ZEN', normalizedName: 'ZEN' },
    { name: 'Fiji', normalizedName: 'Fiji' }
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].resourceName, 'Fiji');
});

test('applySoftwarePolicy: preserves an explicit new/reuse value', () => {
  const out = applySoftwarePolicy([
    { resourceName: 'CustomTool', newReuse: 'new', detectorMeta: {} }
  ]);
  assert.equal(out[0].newReuse, 'new');
});

test('two Softcite mentions of MATLAB → 1 item with mergedFrom=2', () => {
  const raw = [
    { name: 'MATLAB R2019b', normalizedName: 'MATLAB', confidence: 0.7, context: 'first mention' },
    { name: 'MATLAB',        normalizedName: 'MATLAB', confidence: 0.9, context: 'second mention' }
  ];
  const items = dedupeKrtItems(buildKrtItemsSoftware(raw), 'software');

  assert.equal(items.length, 1);
  assert.equal(items[0].mergedFrom.length, 2);
  // Highest confidence (0.9) wins for representative fields
  assert.equal(items[0].confidence, 0.9);
});
