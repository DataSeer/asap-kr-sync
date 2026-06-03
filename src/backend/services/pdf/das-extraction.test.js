/**
 * Tests for das-extraction.service parseGeminiResponse.
 * Run with: node --test src/backend/services/pdf/das-extraction.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseGeminiResponse } = require('./das-extraction.service');

test('parseGeminiResponse: plain JSON object', () => {
  const text = '{"content": "Data are available at https://example.org", "partial_match": false, "section_fragmented": false}';
  const parsed = parseGeminiResponse(text);
  assert.equal(parsed.content, 'Data are available at https://example.org');
  assert.equal(parsed.partialMatch, false);
  assert.equal(parsed.sectionFragmented, false);
});

test('parseGeminiResponse: fenced ```json``` code block', () => {
  const text = '```json\n{"content": "Available on request.", "partial_match": true, "section_fragmented": false}\n```';
  const parsed = parseGeminiResponse(text);
  assert.equal(parsed.content, 'Available on request.');
  assert.equal(parsed.partialMatch, true);
  assert.equal(parsed.sectionFragmented, false);
});

test('parseGeminiResponse: fenced ``` (no language tag)', () => {
  const text = '```\n{"content": "X", "partial_match": false, "section_fragmented": true}\n```';
  const parsed = parseGeminiResponse(text);
  assert.equal(parsed.content, 'X');
  assert.equal(parsed.sectionFragmented, true);
});

test('parseGeminiResponse: snake_case → camelCase mapping', () => {
  const text = '{"content": "", "partial_match": true, "section_fragmented": true}';
  const parsed = parseGeminiResponse(text);
  // The prompt uses snake_case in the JSON output spec; the parser
  // normalises to camelCase for the rest of the pipeline.
  assert.equal(parsed.partialMatch, true);
  assert.equal(parsed.sectionFragmented, true);
});

test('parseGeminiResponse: missing keys default to empty/false', () => {
  const parsed = parseGeminiResponse('{}');
  assert.equal(parsed.content, '');
  assert.equal(parsed.partialMatch, false);
  assert.equal(parsed.sectionFragmented, false);
});

test('parseGeminiResponse: non-string content coerced to empty', () => {
  // Defensive: if Gemini hallucinates a non-string for content we don't
  // want it to leak into the persisted DAS field.
  const parsed = parseGeminiResponse('{"content": 42, "partial_match": false, "section_fragmented": false}');
  assert.equal(parsed.content, '');
});

test('parseGeminiResponse: empty string returns empty result', () => {
  const parsed = parseGeminiResponse('');
  assert.equal(parsed.content, '');
  assert.equal(parsed.partialMatch, false);
  assert.equal(parsed.sectionFragmented, false);
});

test('parseGeminiResponse: malformed JSON returns empty result (no throw)', () => {
  const parsed = parseGeminiResponse('this is not JSON');
  assert.equal(parsed.content, '');
  assert.equal(parsed.partialMatch, false);
  assert.equal(parsed.sectionFragmented, false);
});

test('parseGeminiResponse: null / undefined input safe', () => {
  assert.deepEqual(parseGeminiResponse(null), { content: '', partialMatch: false, sectionFragmented: false });
  assert.deepEqual(parseGeminiResponse(undefined), { content: '', partialMatch: false, sectionFragmented: false });
});
