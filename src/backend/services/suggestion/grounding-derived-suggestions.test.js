/**
 * Grounding's own route into the suggestion list, and the switch that governs it.
 *
 * Suggestions reach a curator two ways. The LM compares the author's KRT with
 * the Generated KRT and proposes adds and updates; separately, and without the
 * model, `appendGroundingUpdates` turns grounding outcomes into edit
 * suggestions. The second route is deterministic — a candidate matched the row
 * by identifier, alias or name and actually carried the value.
 *
 * `grounding.deriveSuggestions` governs that second route, split by case —
 * `{ emptyCell, conflict }` — because the three things grounding can conclude
 * carry very different risk:
 *
 *   emptyCell    fills a blank the author left. Nothing is overwritten.
 *   conflict     the author HAS a value and the manuscript disagrees. Proposing
 *                asks a curator to change curated data on a detector's word.
 *   not_detected raises nothing in ANY configuration — the only action it could
 *                imply is deleting the author's row.
 *
 * Both switches are on in both pipelines: grounding checks the author's rows
 * against the manuscript, which is independent of how detection was prompted.
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

/** The author HAS an identifier and the manuscript disagrees. */
const conflicting = [{
  krtRowId: 'row-1', outcome: 'incomplete', foundValues: {},
  conflicts: [{
    field: 'identifier', authorValue: 'GSE99999',
    manuscriptValue: 'GSE12345', source: 'datasets_detection'
  }],
  reason: 'the manuscript names a different accession'
}];

/** An author row whose identifier is filled in — the conflict case. */
const filledRows = [{ ...authorRows[0], identifier: 'GSE99999' }];

const kinds = (s) => groundingSuggestions(s).map((x) => x.groundingKind).sort();

// ─────────────────────────────────────────────────────────────────────────────
// Empty cell
// ─────────────────────────────────────────────────────────────────────────────

test('an empty cell is filled when emptyCell is on', () => {
  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], filled,
    { deriveSuggestions: { emptyCell: true, conflict: true } });
  const [s] = groundingSuggestions(suggestions);

  assert.equal(s.groundingKind, 'empty_cell');
  assert.equal(s.data.oldValue, '');
  assert.equal(s.data.newValue, 'GSE12345');
  assert.equal(s.confidence, 0.9);
});

test('an empty cell raises nothing when emptyCell is off', () => {
  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], filled,
    { deriveSuggestions: { emptyCell: false, conflict: true } });

  assert.deepEqual(groundingSuggestions(suggestions), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Conflict
// ─────────────────────────────────────────────────────────────────────────────

test('a conflict is proposed when conflict is on', () => {
  const { suggestions } = buildSuggestionsFromLM(filledRows, [], [], conflicting,
    { deriveSuggestions: { emptyCell: true, conflict: true } });
  const [s] = groundingSuggestions(suggestions);

  assert.ok(s, 'the conflict must reach the curator as an action');
  assert.equal(s.groundingKind, 'conflict');
  assert.equal(s.data.oldValue, 'GSE99999', "the author's value is what it proposes to change");
  assert.equal(s.data.newValue, 'GSE12345');
  assert.match(s.description, /your table says .* the manuscript says/);
});

test('a conflict names the detector that raised it', () => {
  // A conflict is only as good as whatever read the manuscript. A curator being
  // asked to overrule their own entry deserves to know what is asking.
  const { suggestions } = buildSuggestionsFromLM(filledRows, [], [], conflicting,
    { deriveSuggestions: { emptyCell: true, conflict: true } });

  assert.equal(groundingSuggestions(suggestions)[0].data.conflictSource, 'datasets_detection');
});

test('a conflict is proposed at lower confidence than a fill', () => {
  const fill = buildSuggestionsFromLM(authorRows, [], [], filled, {});
  const clash = buildSuggestionsFromLM(filledRows, [], [], conflicting, {});

  assert.ok(
    groundingSuggestions(clash.suggestions)[0].confidence < groundingSuggestions(fill.suggestions)[0].confidence,
    'contradicting a human must not read as confidently as filling a blank'
  );
});

test('a conflict raises nothing when conflict is off', () => {
  const { suggestions } = buildSuggestionsFromLM(filledRows, [], [], conflicting,
    { deriveSuggestions: { emptyCell: true, conflict: false } });

  assert.deepEqual(groundingSuggestions(suggestions), [],
    'the conflict is still shown as a conflict; it just raises no action');
});

test('the two cases are independent', () => {
  // One outcome carrying both a fillable blank and a disagreement.
  const rows = [{ ...authorRows[0], identifier: 'GSE99999', source: '' }];
  const both = [{
    krtRowId: 'row-1', outcome: 'incomplete',
    foundValues: { source: 'GEO' },
    conflicts: [{ field: 'identifier', authorValue: 'GSE99999', manuscriptValue: 'GSE12345', source: 'x' }]
  }];

  assert.deepEqual(kinds(buildSuggestionsFromLM(rows, [], [], both, {}).suggestions),
    ['conflict', 'empty_cell']);
  assert.deepEqual(kinds(buildSuggestionsFromLM(rows, [], [], both,
    { deriveSuggestions: { conflict: false } }).suggestions), ['empty_cell']);
  assert.deepEqual(kinds(buildSuggestionsFromLM(rows, [], [], both,
    { deriveSuggestions: { emptyCell: false } }).suggestions), ['conflict']);
  assert.deepEqual(kinds(buildSuggestionsFromLM(rows, [], [], both,
    { deriveSuggestions: { emptyCell: false, conflict: false } }).suggestions), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Defaults, and what never happens
// ─────────────────────────────────────────────────────────────────────────────

test('omitting the policy derives both, matching the shipped behaviour', () => {
  // The offline harnesses call this without a pipeline. Defaulting to off would
  // make them under-report what the real path does.
  const rows = [{ ...authorRows[0], identifier: 'GSE99999', source: '' }];
  const both = [{
    krtRowId: 'row-1', outcome: 'incomplete', foundValues: { source: 'GEO' },
    conflicts: [{ field: 'identifier', authorValue: 'GSE99999', manuscriptValue: 'GSE12345' }]
  }];

  assert.deepEqual(kinds(buildSuggestionsFromLM(rows, [], [], both).suggestions),
    ['conflict', 'empty_cell']);
});

test('both shipped pipelines derive both kinds', () => {
  const rows = [{ ...authorRows[0], identifier: 'GSE99999', source: '' }];
  const both = [{
    krtRowId: 'row-1', outcome: 'incomplete', foundValues: { source: 'GEO' },
    conflicts: [{ field: 'identifier', authorValue: 'GSE99999', manuscriptValue: 'GSE12345' }]
  }];

  for (const pipeline of Object.values(PIPELINES)) {
    const { suggestions } = buildSuggestionsFromLM(rows, [], [], both,
      { deriveSuggestions: pipeline.grounding.deriveSuggestions });
    assert.deepEqual(kinds(suggestions), ['conflict', 'empty_cell'], pipeline.id);
  }
});

test('a row the manuscript never mentions raises nothing, in any configuration', () => {
  // `not_detected` is a tag, not an action: the author's data is right even when
  // the pipeline cannot corroborate it. There is no switch for this.
  const notDetected = [{ krtRowId: 'row-1', outcome: 'not_detected', foundValues: {}, conflicts: [] }];

  for (const policy of [{}, { emptyCell: true, conflict: true }]) {
    const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], notDetected, { deriveSuggestions: policy });
    assert.deepEqual(groundingSuggestions(suggestions), []);
  }
});

test('an outcome for a row that is not in the KRT is ignored', () => {
  // The ablation runs delete rows from the author KRT. An outcome referring to a
  // deleted row has nothing to attach to and must not invent one.
  const orphaned = [{ ...filled[0], krtRowId: 'row-does-not-exist' }];

  const { suggestions } = buildSuggestionsFromLM(authorRows, [], [], orphaned, {});

  assert.deepEqual(groundingSuggestions(suggestions), []);
});

test('a conflict that agrees with itself is not a conflict', () => {
  const noop = [{
    krtRowId: 'row-1', outcome: 'incomplete', foundValues: {},
    conflicts: [{ field: 'identifier', authorValue: 'GSE1', manuscriptValue: 'GSE1' }]
  }];

  const { suggestions } = buildSuggestionsFromLM(filledRows, [], [], noop, {});

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
