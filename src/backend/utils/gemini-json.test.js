/**
 * Tests for sanitizeJsonEscapes — invalid backslash escapes in model JSON.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeJsonEscapes } = require('./gemini-json');

const parse = (raw) => JSON.parse(sanitizeJsonEscapes(raw));

test('fixes LaTeX-style backslash (\\mu) inside a string value', () => {
  const raw = '{"text": "a total of 1.5 \\mu g of plasmid"}';
  assert.throws(() => JSON.parse(raw), 'raw is invalid JSON');
  assert.equal(parse(raw).text, 'a total of 1.5 \\mu g of plasmid');
});

test('fixes malformed \\u (not 4 hex) — the case stripMarkdownEscapes missed', () => {
  const raw = '{"text": "see \\upmu and \\underline"}';
  assert.throws(() => JSON.parse(raw));
  assert.equal(parse(raw).text, 'see \\upmu and \\underline');
});

test('fixes a Windows-style path', () => {
  const raw = '{"path": "C:\\Users\\data"}';
  assert.equal(parse(raw).path, 'C:\\Users\\data');
});

test('leaves valid escapes intact (\\n \\t \\" \\\\)', () => {
  const raw = '{"text": "line1\\nline2\\t\\"q\\"\\\\end"}';
  assert.equal(parse(raw).text, 'line1\nline2\t"q"\\end');
});

test('leaves valid \\uXXXX unicode escapes intact', () => {
  const raw = '{"text": "micro \\u00b5g"}';
  assert.equal(parse(raw).text, 'micro µg');
});

test('valid JSON is unchanged', () => {
  const raw = '{"a": 1, "b": ["x", "y"], "c": "plain text"}';
  assert.equal(sanitizeJsonEscapes(raw), raw);
});
