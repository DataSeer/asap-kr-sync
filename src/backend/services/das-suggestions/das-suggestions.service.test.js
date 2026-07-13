/**
 * Tests for the pure helpers of the DAS suggestions service.
 * Run with: node --test src/backend/services/das-suggestions/das-suggestions.service.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeKrtSignals, buildSuggestions, DAS_RULES } = require('./das-suggestions.service');

// ── computeKrtSignals ────────────────────────────────────────────────

test('computeKrtSignals: derives the 6 booleans from camelCase KRT rows', () => {
  const rows = [
    { resourceType: 'Dataset', newReuse: 'reuse' },
    { resourceType: 'Software/code', newReuse: 'new' },
    { resourceType: 'Antibody', newReuse: 'reuse' }
  ];
  assert.deepEqual(computeKrtSignals(rows), {
    has_new_dataset: false,
    has_new_code: true,
    has_dataset_resources: true,
    has_code_resources: true,
    has_protocol_resources: false,
    has_lab_material_resources: true
  });
});

test('computeKrtSignals: new dataset + protocol detected, case-insensitive', () => {
  const rows = [
    { resourceType: 'DATASET', newReuse: 'New' },
    { resourceType: 'Protocol', newReuse: 'reuse' }
  ];
  const s = computeKrtSignals(rows);
  assert.equal(s.has_new_dataset, true);
  assert.equal(s.has_protocol_resources, true);
  assert.equal(s.has_code_resources, false);
});

test('computeKrtSignals: empty/undefined rows → all false', () => {
  const s = computeKrtSignals([]);
  assert.ok(Object.values(s).every(v => v === false));
  assert.deepEqual(computeKrtSignals(undefined), s);
});

// ── buildSuggestions ─────────────────────────────────────────────────

test('buildSuggestions: returns one entry per rule, in catalog order', () => {
  const out = buildSuggestions([], {}, '');
  assert.equal(out.length, DAS_RULES.length);
  assert.deepEqual(out.map(o => o.ruleId), DAS_RULES.map(r => r.id));
});

test('buildSuggestions: applies + reason come from the LM; presentation from catalog', () => {
  const findings = [
    { rule_id: 'no_new_dataset', applies: true, reason: 'no new dataset in KRT' },
    { rule_id: 'missing_krt_reference', applies: false, reason: 'DAS cites the Zenodo DOI' }
  ];
  const out = buildSuggestions(findings);

  const applied = out.find(o => o.ruleId === 'no_new_dataset');
  assert.equal(applied.applies, true);
  assert.equal(applied.notApplicableReason, null);
  assert.equal(applied.severity, 'warning');
  assert.ok(applied.recommendedText.includes('No new primary data'));

  const passed = out.find(o => o.ruleId === 'missing_krt_reference');
  assert.equal(passed.applies, false);
  assert.equal(passed.notApplicableReason, 'DAS cites the Zenodo DOI'); // LM reason wins
});

test('buildSuggestions: a rule the LM omitted defaults to not-applicable with the catalog reason', () => {
  const out = buildSuggestions([{ rule_id: 'no_new_dataset', applies: true, reason: 'x' }]);
  const omitted = out.find(o => o.ruleId === 'code_not_mentioned');
  assert.equal(omitted.applies, false);
  assert.equal(omitted.notApplicableReason, DAS_RULES.find(r => r.id === 'code_not_mentioned').naReason);
});

test('buildSuggestions: ignores malformed findings (non-boolean applies, missing id)', () => {
  const out = buildSuggestions([{ applies: true }, { rule_id: 'no_new_code', applies: 'yes' }]);
  // no_new_code got a non-boolean applies → treated as not-applicable
  assert.equal(out.find(o => o.ruleId === 'no_new_code').applies, false);
});
