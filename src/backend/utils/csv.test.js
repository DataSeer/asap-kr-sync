/**
 * Tests for CSV escaping / formula-injection guard
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { escapeCsvField, stripCsvFormulaGuard } = require('./csv');

test('escapeCsvField: plain values pass through', () => {
  assert.strictEqual(escapeCsvField('anti-GFP antibody'), 'anti-GFP antibody');
  assert.strictEqual(escapeCsvField(42), '42');
});

test('escapeCsvField: null/undefined become empty string', () => {
  assert.strictEqual(escapeCsvField(null), '');
  assert.strictEqual(escapeCsvField(undefined), '');
});

test('escapeCsvField: RFC-4180 quoting for comma, quote, newline', () => {
  assert.strictEqual(escapeCsvField('a,b'), '"a,b"');
  assert.strictEqual(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.strictEqual(escapeCsvField('line1\nline2'), '"line1\nline2"');
});

test('escapeCsvField: neutralizes formula triggers', () => {
  assert.strictEqual(escapeCsvField('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.strictEqual(escapeCsvField('=1+2'), "'=1+2");
  assert.strictEqual(escapeCsvField('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(escapeCsvField('+cmd'), "'+cmd");
  assert.strictEqual(escapeCsvField('-2+3'), "'-2+3");
  assert.strictEqual(escapeCsvField('\t=x'), "'\t=x");
});

test('escapeCsvField: formula trigger mid-string is untouched', () => {
  assert.strictEqual(escapeCsvField('pH = 7.4'), 'pH = 7.4');
});

test('stripCsvFormulaGuard: reverses the guard, round-trips values', () => {
  for (const original of ['-80°C', '=1+2', '@handle', 'plain', "'quoted but safe"]) {
    const guarded = original.match(/^[=+\-@\t\r]/) ? "'" + original : original;
    assert.strictEqual(stripCsvFormulaGuard(guarded), original);
  }
});

test('stripCsvFormulaGuard: leaves legitimate apostrophes alone', () => {
  assert.strictEqual(stripCsvFormulaGuard("'s-Hertogenbosch strain"), "'s-Hertogenbosch strain");
  assert.strictEqual(stripCsvFormulaGuard(123), 123);
  assert.strictEqual(stripCsvFormulaGuard(null), null);
});
