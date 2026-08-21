/**
 * Tests for how grounding outcomes become suggestions.
 *
 * These pin the rule the whole design rests on: **the author's KRT is never
 * modified.** Concretely —
 *   - a `not_detected` row produces NO suggestion (it is a tag, not an action)
 *   - a non-empty author cell is never proposed for change
 *   - a deterministic grounding fill wins over an LM proposal for the same cell
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSuggestionsFromLM } = require('./kr-comparison.service');

const authorRow = (over = {}) => ({
  id: 'row-1',
  resourceType: 'Software/code',
  resourceName: 'CellProfiler',
  identifier: '',
  source: '',
  newReuse: 'reuse',
  additionalInformation: '',
  ...over
});

const outcome = (over = {}) => ({
  krtRowId: 'row-1',
  resourceType: 'Software/code',
  resourceName: 'CellProfiler',
  outcome: 'incomplete',
  matchedBy: 'name',
  matchedRefs: [0],
  evidence: { quote: 'analysed in CellProfiler', offset: 5, section: 'Methods', match: 'exact' },
  missingFields: ['identifier'],
  foundValues: { identifier: 'RRID:SCR_007358' },
  reason: 'Found in the manuscript (matched by name).',
  ...over
});

test('an incomplete outcome proposes a fill for the empty cell', () => {
  const { suggestions } = buildSuggestionsFromLM([authorRow()], [], [], [outcome()]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].type, 'edit');
  assert.equal(suggestions[0].source, 'krt_grounding');
  assert.equal(suggestions[0].data.column, 'identifier');
  assert.equal(suggestions[0].data.oldValue, '');
  assert.equal(suggestions[0].data.newValue, 'RRID:SCR_007358');
  assert.equal(suggestions[0].matchedKrtRowId, 'row-1');
});

test('a not_detected outcome produces NO suggestion — it is a tag, not an action', () => {
  const { suggestions, decisions } = buildSuggestionsFromLM(
    [authorRow()],
    [],
    [],
    [outcome({ outcome: 'not_detected', missingFields: [], foundValues: {}, matchedBy: null })]
  );
  assert.deepEqual(suggestions, []);
  assert.deepEqual(decisions, []);
});

test('a confirmed outcome produces no suggestion', () => {
  const { suggestions } = buildSuggestionsFromLM(
    [authorRow()], [], [], [outcome({ outcome: 'confirmed', missingFields: [], foundValues: {} })]
  );
  assert.deepEqual(suggestions, []);
});

test('never proposes a change to a NON-EMPTY author cell', () => {
  const { suggestions } = buildSuggestionsFromLM(
    [authorRow({ identifier: 'RRID:SCR_ALREADY_THERE' })],
    [],
    [],
    [outcome()] // outcome still claims identifier is missing — stale
  );
  assert.deepEqual(suggestions, [], 'a filled cell is untouchable even if the outcome is stale');
});

test('an outcome for an unknown row id is ignored', () => {
  const { suggestions } = buildSuggestionsFromLM(
    [authorRow()], [], [], [outcome({ krtRowId: 'does-not-exist' })]
  );
  assert.deepEqual(suggestions, []);
});

test('a grounding fill wins the dedupe against an LM proposal for the same cell', () => {
  const lmDecisions = [{
    action: 'update',
    authorRowId: 'row-1',
    generatedRef: 0,
    changes: { identifier: 'RRID:SCR_LM_GUESS' },
    reason: 'lm proposal'
  }];
  const generatedKrt = [{ resourceType: 'Software/code', resourceName: 'CellProfiler', identifier: 'RRID:SCR_LM_GUESS', detectedBy: [] }];

  const { suggestions } = buildSuggestionsFromLM([authorRow()], generatedKrt, lmDecisions, [outcome()]);
  const identifierEdits = suggestions.filter((s) => s.data?.column === 'identifier');

  assert.equal(identifierEdits.length, 1, 'exactly one proposal for the cell');
  assert.equal(identifierEdits[0].source, 'krt_grounding');
  assert.equal(identifierEdits[0].data.newValue, 'RRID:SCR_007358');
});

test('no grounding outcomes → behaves exactly as before', () => {
  const { suggestions, decisions } = buildSuggestionsFromLM([authorRow()], [], []);
  assert.deepEqual(suggestions, []);
  assert.deepEqual(decisions, []);
});

test('a fill is carried with its evidence so a curator can check it', () => {
  const { suggestions } = buildSuggestionsFromLM([authorRow()], [], [], [outcome()]);
  assert.equal(suggestions[0].evidence.section, 'Methods');
  assert.equal(suggestions[0].evidence.match, 'exact');
});
