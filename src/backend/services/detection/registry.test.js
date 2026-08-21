/**
 * Guards on the strategy registry and the pipelines that compose it.
 *
 * The contract test here is the important one. If a strategy's prompt stops
 * asking for an evidence quote, evidence goes null through merge, consolidation
 * and suggestions and NOTHING THROWS — which is exactly how the LangExtract
 * output field and the alias tier failed, masked by a default, for months.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getStrategy, allStrategies } = require('./registry');
const { PIPELINES, DEFAULT_PIPELINE_ID, getPipeline } = require('../../config/pipelines');

test('every strategy prompt asks for an evidence field', () => {
  for (const strategy of allStrategies()) {
    for (const file of strategy.promptFiles) {
      const text = fs.readFileSync(file, 'utf-8');
      assert.ok(
        /evidence_quote|text_excerpt/.test(text),
        `${strategy.id}: ${path.basename(file)} never asks for an evidence field, so every item it produces will be unverifiable`
      );
    }
  }
});

test('a signals prompt is declared, and exists', () => {
  // Separate from promptFiles because it produces signals rather than resource
  // records — but just as required, and it was previously declared nowhere at
  // all, so `detectionPromptsExist` reported the module runnable without it.
  for (const strategy of allStrategies()) {
    for (const file of strategy.signalsPromptFiles || []) {
      assert.ok(fs.existsSync(file), `${strategy.id}: ${path.basename(file)} is missing`);
      assert.ok(fs.readFileSync(file, 'utf-8').trim().length > 0, `${strategy.id}: ${path.basename(file)} is empty`);
    }
  }
});

test('every strategy prompt file exists and is not empty', () => {
  for (const strategy of allStrategies()) {
    for (const file of strategy.promptFiles) {
      assert.ok(fs.existsSync(file), `${strategy.id}: missing prompt ${file}`);
      assert.ok(fs.readFileSync(file, 'utf-8').trim().length > 100, `${strategy.id}: prompt looks empty`);
    }
  }
});

test('seeded prompts carry a Section 0; blind prompts must not', () => {
  for (const strategy of allStrategies()) {
    const text = fs.readFileSync(strategy.promptFiles[0], 'utf-8');
    const seeded = strategy.id.endsWith('.seeded');
    const mentionsAuthorKrt = /AUTHOR-PROVIDED|author_provided_datasets|SEED FIRST/i.test(text);
    if (seeded) {
      assert.ok(mentionsAuthorKrt, `${strategy.id}: a seeded prompt with no seed section cannot use its seeds`);
    } else {
      assert.ok(!mentionsAuthorKrt,
        `${strategy.id}: a blind prompt referencing the author KRT would ask for input it is never given`);
    }
  }
});

test('every strategy id a pipeline references resolves', () => {
  for (const pipeline of Object.values(PIPELINES)) {
    for (const [detector, id] of Object.entries(pipeline.strategies)) {
      const strategy = getStrategy(id);       // throws on a typo
      assert.equal(strategy.detector, detector,
        `${pipeline.id}: ${id} is a ${strategy.detector} strategy, wired as ${detector}`);
    }
  }
});

test('exactly one pipeline is the default, and it is the seeded one', () => {
  const defaults = Object.values(PIPELINES).filter((p) => p.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, DEFAULT_PIPELINE_ID);
  // Everyone keeps today's behaviour until a pipeline is chosen deliberately.
  assert.equal(defaults[0].adminOnly, false);
  assert.ok(defaults[0].id.startsWith('seeded'));
});

test('a seeded pipeline never surfaces candidate-derived grounding', () => {
  // In seeded mode the candidate pool contains the model's echo of the author's
  // own rows, so a match means "it repeated what we handed it". Surfacing that
  // asserts something the output cannot support.
  for (const pipeline of Object.values(PIPELINES)) {
    const isSeeded = Object.values(pipeline.strategies).some((id) => id.endsWith('.seeded'));
    if (!isSeeded) continue;
    assert.equal(pipeline.grounding.surfaceValues, false, `${pipeline.id}`);
    assert.equal(pipeline.grounding.deriveSuggestions, false, `${pipeline.id}`);
  }
});

test('presence grounding is surfaced in every pipeline', () => {
  // It is a deterministic search of the author's row against the manuscript and
  // cannot be affected by what the prompts were given.
  for (const pipeline of Object.values(PIPELINES)) {
    assert.equal(pipeline.grounding.surfacePresence, true, `${pipeline.id}`);
  }
});

test('unknown ids throw rather than falling back', () => {
  assert.throws(() => getPipeline('does-not-exist'), /Unknown pipeline/);
  assert.throws(() => getStrategy('does-not-exist'), /Unknown detection strategy/);
  assert.equal(getPipeline().id, DEFAULT_PIPELINE_ID);   // empty means default
});

test('materials falls back to a discovery prompt when there is nothing to seed', () => {
  // dev skipped materials entirely for a submission whose KRT lists no
  // materials, leaving the module with zero capacity in the case that needs it
  // most. The fallback needs a DIFFERENT prompt, not just an empty seed list:
  // the seeded prompt still says "do not re-derive a materials list from
  // scratch", which handed no seeds is an instruction to find nothing.
  const materials = allStrategies().find((s) => s.id === 'materials.seeded');
  assert.equal(materials.promptFiles.length, 2, 'a seeded prompt and a discovery fallback');

  const [seeded, discovery] = materials.promptFiles.map((f) => fs.readFileSync(f, 'utf-8'));
  assert.notEqual(seeded, discovery);
  assert.ok(/SEED FIRST|AUTHOR-PROVIDED/i.test(seeded), 'the seeded prompt bases on the author rows');
  assert.ok(!/SEED FIRST|AUTHOR-PROVIDED/i.test(discovery),
    'the fallback must not reference rows it will never be given');
  assert.ok(/DISCOVERY/i.test(discovery), 'and must actually ask for discovery');
});

test('tagAuthorRows marks only rows the author listed, and only when seeded', () => {
  const { tagAuthorRows } = require('./tag-author-rows');
  const items = [
    { resourceName: 'Rabbit anti-TH' },
    { resourceName: 'Something the model found', detectorMeta: { relevance: 'HIGH' } }
  ];
  const seeds = [{ name: 'rabbit  ANTI-TH' }];   // case and spacing differ

  const tagged = tagAuthorRows(items, seeds);
  assert.equal(tagged[0].detectorMeta.fromAuthorKrt, true, 'matched despite case and spacing');
  assert.equal(tagged[1].detectorMeta.fromAuthorKrt, undefined, 'a genuine discovery is not tagged');
  assert.equal(tagged[1].detectorMeta.relevance, 'HIGH', 'existing detectorMeta survives');

  // A blind pipeline seeds nothing, and must carry no tag at all rather than a
  // tag that is always false.
  const untagged = tagAuthorRows(items, []);
  assert.equal(untagged[0].detectorMeta, undefined);
  assert.deepEqual(tagAuthorRows(items, null), items);
});
