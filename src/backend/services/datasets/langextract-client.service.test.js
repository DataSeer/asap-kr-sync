/**
 * Tests for the LangExtract client's grounding gate.
 *
 * Context: a batch run produced nine "datasets" on one manuscript that appeared
 * nowhere in it — they were the few-shot examples from the extraction prompt,
 * echoed back by the model when the article turned out to be sparse. They were
 * indistinguishable from real findings downstream because the client discarded
 * LangExtract's `char_interval`, which is the only thing that separates an
 * extraction aligned to the article from one the model produced from memory.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  buildExtractedRows,
  partitionByGrounding
} = require('./langextract-client.service');

test('buildExtractedRows reads extraction_text (not the old extracted_text key)', () => {
  const rows = buildExtractedRows([
    {
      extraction_class: 'DATASET_ROW',
      extraction_text: 'deposited in GEO under GSE12345',
      char_interval: { start_pos: 10, end_pos: 41 },
      alignment_status: 'MATCH_EXACT',
      attributes: { dataset_name: 'RNA-seq' }
    }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'deposited in GEO under GSE12345');
  assert.deepEqual(rows[0].charInterval, { start_pos: 10, end_pos: 41 });
  assert.equal(rows[0].alignmentStatus, 'MATCH_EXACT');
});

test('buildExtractedRows keeps only DATASET_ROW extractions', () => {
  const rows = buildExtractedRows([
    { extraction_class: 'DATASET_ROW', extraction_text: 'a', attributes: {} },
    { extraction_class: 'REPOSITORY', extraction_text: 'GEO', attributes: {} }
  ]);
  assert.equal(rows.length, 1);
});

test('partitionByGrounding separates aligned extractions from unaligned ones', () => {
  const { grounded, ungrounded } = partitionByGrounding([
    { text: 'real', charInterval: { start_pos: 0, end_pos: 4 }, attributes: { dataset_name: 'Real' } },
    { text: 'echoed example', charInterval: null, attributes: { dataset_name: 'UK Biobank WES' } }
  ]);

  assert.equal(grounded.length, 1);
  assert.equal(grounded[0].attributes.dataset_name, 'Real');
  assert.equal(ungrounded.length, 1);
  assert.equal(ungrounded[0].attributes.dataset_name, 'UK Biobank WES');
});

test('partitionByGrounding treats start_pos 0 as grounded, not falsy', () => {
  const { grounded, ungrounded } = partitionByGrounding([
    { text: 'at the very start', charInterval: { start_pos: 0, end_pos: 17 }, attributes: {} }
  ]);
  assert.equal(grounded.length, 1, 'offset 0 is a valid span');
  assert.equal(ungrounded.length, 0);
});

test('partitionByGrounding rejects a malformed interval with no numeric start', () => {
  const { grounded, ungrounded } = partitionByGrounding([
    { text: 'x', charInterval: { start_pos: null, end_pos: 5 }, attributes: {} },
    { text: 'y', charInterval: {}, attributes: {} }
  ]);
  assert.equal(grounded.length, 0);
  assert.equal(ungrounded.length, 2);
});

test('partitionByGrounding on an empty list returns two empty lists', () => {
  const { grounded, ungrounded } = partitionByGrounding([]);
  assert.deepEqual(grounded, []);
  assert.deepEqual(ungrounded, []);
});
