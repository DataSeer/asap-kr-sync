/**
 * Grounding's own route into the suggestion list, and the switch that governs it.
 *
 * Suggestions reach a curator two ways. The LM compares the author's KRT with
 * the Generated KRT and proposes adds and updates; separately, and without the
 * model, `appendGroundingUpdates` turns grounding outcomes into edit
 * suggestions. The second route is deterministic — a candidate matched the row
 * by identifier, alias or name and actually carried the value.
 *
 * `grounding.deriveSuggestions` is the pipeline's switch for that second route.
 * It is TRUE in both pipelines: grounding checks the author's rows against the
 * manuscript, which is independent of how detection was prompted. The switch is
 * kept for a deployment that would rather show the findings and let a curator
 * act on them, raising no suggestion on their behalf.
 *
 * The flag previously existed in config and was read by nothing — declared
 * false for the seeded pipeline while the code derived suggestions anyway. The
 * registry test asserted the config value, which is why nothing noticed. These
 * tests assert the BEHAVIOUR instead.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-for-signing-anything-real';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSuggestionsFromLM } = require('./kr-comparison.service');
const { PIPELINES } = require('../../config/pipelines');

/** An author row with an empty IDENTIFIER — the cell grounding may fill. */
const authorRows = [{
  id: 'row-1', resourceType: 'Dataset', resourceName: 'RNA-seq counts',
  source: 'GEO', identifier: '', newReuse: ''
}];

/** Grounding found an identifier for that empty cell. */
const filled = [{
  krtRowId: 'row-1', outcome: 'incomplete',
  foundValues: { identifier: 'GSE12345' },
  reason: 'located in the methods section', evidence: null
}];

const groundingSuggestions = (s) => s.filter((x) => x.source === 'krt_grounding');

// ─────────────────────────────────────────────────────────────────────────────
// The switch
// ─────────────────────────────────────────────────────────────────────────────

test('an empty cell grounding can fill becomes a suggestion when the flag is on', () => {
  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], filled, { deriveSuggestions: true });
  const fromGrounding = groundingSuggestions(suggestions);

  assert.equal(fromGrounding.length, 1);
  assert.equal(fromGrounding[0].data.column, 'identifier');
  assert.equal(fromGrounding[0].data.newValue, 'GSE12345');
  assert.equal(fromGrounding[0].data.oldValue, '');
});

test('the same outcome raises nothing when the flag is off', () => {
  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], filled, { deriveSuggestions: false });

  assert.deepEqual(groundingSuggestions(suggestions), [],
    'turning the switch off must actually stop the route, not just be recorded');
});

test('omitting the option derives suggestions, matching the shipped behaviour', () => {
  // The offline harnesses call this without a pipeline. Defaulting to off would
  // make them under-report what the real path does.
  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], filled);

  assert.equal(groundingSuggestions(suggestions).length, 1);
});

test('both shipped pipelines have the switch on', () => {
  for (const pipeline of Object.values(PIPELINES)) {
    const { suggestions } = buildSuggestionsFromLM(
      authorRows, [], [], filled, { deriveSuggestions: pipeline.grounding.deriveSuggestions }
    );
    assert.equal(groundingSuggestions(suggestions).length, 1,
      `${pipeline.id} must derive grounding suggestions`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// What the route does NOT do, in either setting
// ─────────────────────────────────────────────────────────────────────────────

test('a conflict never becomes a suggestion', () => {
  // The author has a value and the manuscript disagrees. That is surfaced as a
  // conflict for a curator to weigh — the author's entry stands. Turning it into
  // an edit suggestion would invite someone to overwrite curated data on the
  // say-so of a detector that may itself be wrong.
  const rows = [{ ...authorRows[0], identifier: 'GSE99999' }];
  const conflicting = [{
    krtRowId: 'row-1', outcome: 'incomplete',
    foundValues: { identifier: 'GSE12345' },
    conflicts: [{ field: 'identifier', authorValue: 'GSE99999', foundValue: 'GSE12345' }],
    reason: 'disagrees with the manuscript'
  }];

  const { suggestions } = buildSuggestionsFromLM(rows, [], [], conflicting, { deriveSuggestions: true });

  assert.deepEqual(groundingSuggestions(suggestions), [],
    'a populated cell must never be proposed over, even with the switch on');
});

test('a row the manuscript never mentions raises nothing', () => {
  // `not_detected` is a tag, not an action: the author's data is right even when
  // the pipeline cannot corroborate it.
  const notDetected = [{ krtRowId: 'row-1', outcome: 'not_detected', foundValues: {} }];

  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], notDetected, { deriveSuggestions: true });

  assert.deepEqual(groundingSuggestions(suggestions), []);
});

test('an outcome for a row that is not in the KRT is ignored', () => {
  // The ablation runs delete rows from the author KRT. An outcome referring to a
  // deleted row has nothing to attach to and must not invent one.
  const orphaned = [{ ...filled[0], krtRowId: 'row-does-not-exist' }];

  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], orphaned, { deriveSuggestions: true });

  assert.deepEqual(groundingSuggestions(suggestions), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// The real path threads the policy
// ─────────────────────────────────────────────────────────────────────────────

test('generateSuggestions passes the pipeline policy to the builder', () => {
  // The tests above call buildSuggestionsFromLM directly, so they prove the
  // switch works without proving anything USES it. That is exactly how the flag
  // came to sit in config, read by nothing, while a test asserted its value.
  //
  // Exercising generateSuggestions end to end would mean stubbing Gemini, the
  // models and the run-input recorder; scanning the one call site is
  // proportionate and catches the regression that matters — someone dropping
  // the argument.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'kr-comparison.service.js'), 'utf8');

  // The CALL that receives grounding outcomes — the real path. `function ` in
  // front means the declaration, whose parameter list reads almost identically;
  // matching that instead is how the first draft of this test passed for the
  // wrong reason. compareKrts also calls the builder, without grounding, and is
  // not what this guards.
  const calls = [...source.matchAll(/(function\s+)?buildSuggestionsFromLM\(\s*authorRows,\s*generatedKrt,\s*lmDecisions,\s*groundingOutcomes[\s\S]{0,200}?\)/g)]
    .filter((m) => !m[1]);

  assert.equal(calls.length, 1, 'expected exactly one grounding-aware call site');
  assert.match(calls[0][0], /deriveSuggestions/,
    'the real call site must pass the pipeline switch, or the flag is decoration again');
  assert.match(source, /const policy = getPipeline\([^)]*\)\.grounding/,
    'the policy must come from the submission\'s pipeline, not a literal');
});
