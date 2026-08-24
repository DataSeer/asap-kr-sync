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

const fs = require('node:fs');
const path = require('node:path');

const {
  buildChildEnv,
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

/**
 * The child-process environment.
 *
 * Context: the .env rework collapsed nine per-module Gemini keys into one
 * shared GEMINI_API_KEY. Every Node-side check kept reporting datasets
 * detection "on", because the config resolves the fallback -- but the
 * LangExtract script reads the per-module name straight out of its own
 * environment, and exited 1 on all five QA manuscripts. The step went
 * `unusable` and held grounding, PDF analysis and suggestions behind it.
 *
 * `server.js` now normalises the environment at startup, so under the app the
 * variable is really set before anything reads it. These pin the boundary
 * itself, which is what the detection scripts under `scripts/` depend on: they
 * load their own .env and never run the startup pass.
 */
test('child env carries the per-module key when only the shared key is set', () => {
  const saved = {
    per: process.env.DATASETS_DETECTION_GEMINI_API_KEY,
    shared: process.env.GEMINI_API_KEY
  };
  try {
    delete process.env.DATASETS_DETECTION_GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'shared-key-only';
    assert.equal(
      buildChildEnv().DATASETS_DETECTION_GEMINI_API_KEY, 'shared-key-only',
      'the script reads this name and nothing else sets it'
    );
  } finally {
    if (saved.per === undefined) delete process.env.DATASETS_DETECTION_GEMINI_API_KEY;
    else process.env.DATASETS_DETECTION_GEMINI_API_KEY = saved.per;
    if (saved.shared === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.shared;
  }
});

test('a key of the module\'s own still wins at the boundary', () => {
  const saved = {
    per: process.env.DATASETS_DETECTION_GEMINI_API_KEY,
    shared: process.env.GEMINI_API_KEY
  };
  try {
    process.env.GEMINI_API_KEY = 'shared';
    process.env.DATASETS_DETECTION_GEMINI_API_KEY = 'own';
    assert.equal(buildChildEnv().DATASETS_DETECTION_GEMINI_API_KEY, 'own');
  } finally {
    if (saved.per === undefined) delete process.env.DATASETS_DETECTION_GEMINI_API_KEY;
    else process.env.DATASETS_DETECTION_GEMINI_API_KEY = saved.per;
    if (saved.shared === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.shared;
  }
});

test('with no key configured at all, the variable is left unset', () => {
  // Not an empty string: the script tells the operator which variables it
  // looked for, and an empty value would instead reach langextract as a
  // credential and fail somewhere less obvious.
  const saved = {
    per: process.env.DATASETS_DETECTION_GEMINI_API_KEY,
    shared: process.env.GEMINI_API_KEY
  };
  try {
    delete process.env.DATASETS_DETECTION_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    assert.equal('DATASETS_DETECTION_GEMINI_API_KEY' in buildChildEnv(), false);
  } finally {
    if (saved.per !== undefined) process.env.DATASETS_DETECTION_GEMINI_API_KEY = saved.per;
    if (saved.shared !== undefined) process.env.GEMINI_API_KEY = saved.shared;
  }
});

test('building the child env does not mutate the parent process', () => {
  const saved = process.env.MATERIALS_DETECTION_GEMINI_MODEL;
  try {
    delete process.env.MATERIALS_DETECTION_GEMINI_MODEL;
    buildChildEnv();
    assert.equal(
      'MATERIALS_DETECTION_GEMINI_MODEL' in process.env, false,
      'the boundary fills in a COPY; mutating process.env here would leak into '
      + 'every later read in this process'
    );
  } finally {
    if (saved !== undefined) process.env.MATERIALS_DETECTION_GEMINI_MODEL = saved;
  }
});

test('child env still inherits the rest of the parent environment', () => {
  process.env.__LANGEXTRACT_PROBE = 'inherited';
  try {
    assert.equal(buildChildEnv().__LANGEXTRACT_PROBE, 'inherited');
  } finally {
    delete process.env.__LANGEXTRACT_PROBE;
  }
});

/**
 * Structural: the script's REQUIRED variables -- the ones read with no default
 * -- are the caller's responsibility, because only the caller knows how the
 * name was resolved. A variable read WITH a default looks the same in the
 * source and needs nothing from us, so the scan ignores those: the model is
 * read that way, and is passed as --model regardless.
 *
 * Snapshotting the set is the point. A new required variable added to the
 * script fails this test and forces the author to decide how it gets supplied,
 * instead of the script exiting 1 on the next real manuscript.
 */
test('the python script requires only keys the caller knows about', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '../../python/datasets/extract-signals.py'), 'utf8'
  );
  // `os.environ.get("X")` with no second argument. The closing paren with no
  // comma is what separates a required read from one carrying its own default.
  const required = [...script.matchAll(/os\.environ\.get\(\s*"([A-Z_]+)"\s*\)/g)]
    .map((m) => m[1]).sort();

  assert.deepEqual(
    [...new Set(required)],
    ['DATASETS_DETECTION_GEMINI_API_KEY', 'GEMINI_API_KEY'],
    'extract-signals.py requires a variable this test has not seen. Supply it '
    + 'from buildChildEnv(), or give the script a default, then update this list.'
  );

});
