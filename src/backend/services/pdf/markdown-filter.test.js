/**
 * Tests for the markdown filter (pure filterMarkdown + keepText). No DB, no LM.
 *
 * The contract is KEEP-BIASED: only numeric data matrices with no resource signal
 * are dropped; prose and resource tables are always kept.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { filterMarkdown, keepText } = require('./markdown-filter.service');

test('drops a numeric data matrix (fold-change / p-value table)', () => {
  const md = [
    '## Results',
    'We observed a strong effect.',
    '',
    '| Gene | log2FC | p value |',
    '| AKD1 | 1.03 | 0.830199 |',
    '| AKD2 | 0.88 | 0.556365 |',
    '| AKD3 | 2.22 | 0.002189 |'
  ].join('\n');
  const { markdown } = filterMarkdown(md);
  assert.ok(markdown.includes('We observed a strong effect.'), 'prose kept');
  assert.ok(!markdown.includes('0.830199'), 'numeric matrix dropped');
});

test('drops space-separated numeric dump lines', () => {
  const md = 'Methods text here describing the assay.\n1.03 0.83 0.88 2.22 0.99 1.26 1.57 0.94 1.01 #DIV/0! 1.10 1.13';
  const { markdown } = filterMarkdown(md);
  assert.ok(markdown.includes('Methods text here'), 'prose kept');
  assert.ok(!markdown.includes('#DIV/0!'), 'numeric dump line dropped');
});

test('KEEPS a reagent/materials table (vendor + catalog + RRID)', () => {
  const md = [
    '| Reagent | Source | Identifier |',
    '| anti-CD45 BV750 | BD Biosciences | Cat. No. 746947; RRID:AB_2871734 |',
    '| anti-TH | Abcam | RRID:AB_123 |'
  ].join('\n');
  const { markdown } = filterMarkdown(md);
  assert.ok(markdown.includes('RRID:AB_2871734'), 'resource table kept whole');
  assert.ok(markdown.includes('anti-TH'));
});

test('KEEPS a data-availability line carrying a DOI/accession', () => {
  const md = 'Data availability\n10.5281/zenodo.123456 and GSE328400 are deposited.';
  const { markdown } = filterMarkdown(md);
  assert.ok(markdown.includes('GSE328400'), 'cue line kept');
});

test('KEEPS a numeric-looking table that contains one accession (cue wins)', () => {
  const md = [
    '| Sample | value1 | value2 |',
    '| GSM12345 | 0.30 | 0.67 |',
    '| ctrl | 0.48 | 1.04 |'
  ].join('\n');
  const { markdown } = filterMarkdown(md);
  assert.ok(markdown.includes('GSM12345'), 'accession cue keeps the whole table');
});

test('KEEPS an oligo/sequence table (letters → high language ratio)', () => {
  const md = [
    '| Name | Sequence |',
    '| primer-F | ACGTACGTACGTACGTACGT |',
    '| primer-R | TTGGCCAATTGGCCAATTGG |'
  ].join('\n');
  const { markdown } = filterMarkdown(md);
  assert.ok(markdown.includes('ACGTACGTACGTACGTACGT'), 'sequence table kept');
});

test('keepText: keep-biased boundary', () => {
  assert.equal(keepText('1.03 0.83 0.88 0.99 1.26', 0.3), false);   // numeric, no cue → drop
  assert.equal(keepText('We measured locomotion in adult flies.', 0.3), true); // prose → keep
  assert.equal(keepText('| 0.83 | RRID:AB_1 |', 0.3), true);        // cue → keep
});

test('stats report what was removed', () => {
  const md = 'Intro paragraph with words.\n\n1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0 9.0 10.0 11.0 12.0';
  const { stats } = filterMarkdown(md);
  assert.ok(stats.charsDropped > 0);
  assert.ok(stats.charsAfter < stats.charsBefore);
});
