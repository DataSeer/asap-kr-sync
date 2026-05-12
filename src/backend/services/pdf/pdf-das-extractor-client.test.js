/**
 * Tests for pdf-das-extractor-client.
 *
 * extractDAS hits the Modal endpoint and isn't covered here. We do unit-test
 * `pickExtractedText` — the response-shape adapter — because the upstream
 * docs don't pin down the JSON contract and this is where drift would hurt.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pickExtractedText } = require('./pdf-das-extractor-client.service');

test('pickExtractedText: plain string response', () => {
  assert.equal(pickExtractedText('Some DAS text'), 'Some DAS text');
});

test('pickExtractedText: null / undefined / wrong type → empty string', () => {
  assert.equal(pickExtractedText(null), '');
  assert.equal(pickExtractedText(undefined), '');
  assert.equal(pickExtractedText(42), '');
});

test('pickExtractedText: { text } shape', () => {
  assert.equal(pickExtractedText({ text: 'data is available' }), 'data is available');
});

test('pickExtractedText: { extracted_das } shape (legacy)', () => {
  assert.equal(pickExtractedText({ extracted_das: 'legacy text' }), 'legacy text');
});

test('pickExtractedText: { section_text } shape', () => {
  assert.equal(pickExtractedText({ section_text: 'from section_text' }), 'from section_text');
});

test('pickExtractedText: { content } shape', () => {
  assert.equal(pickExtractedText({ content: 'content body' }), 'content body');
});

test('pickExtractedText: { das } shape (section-keyed)', () => {
  // The fallback uses the configured section key; default is `das`.
  assert.equal(pickExtractedText({ das: 'keyed by section' }), 'keyed by section');
});

test('pickExtractedText: { das: { text } } shape (nested section)', () => {
  assert.equal(pickExtractedText({ das: { text: 'nested text' } }), 'nested text');
});

test('pickExtractedText: prefers `text` over `content` when both present', () => {
  assert.equal(
    pickExtractedText({ text: 'winner', content: 'loser' }),
    'winner'
  );
});

test('pickExtractedText: empty strings are skipped → returns ""', () => {
  assert.equal(pickExtractedText({ text: '', content: '', das: '' }), '');
});

test('pickExtractedText: whitespace-only strings are skipped', () => {
  assert.equal(pickExtractedText({ text: '   ', content: 'real' }), 'real');
});

test('pickExtractedText: unknown shape → empty string', () => {
  assert.equal(pickExtractedText({ unrelated: 'foo', other: 'bar' }), '');
});
