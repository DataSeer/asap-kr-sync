/**
 * The AI suggestions step lost EVERY suggestion when its response was truncated.
 *
 * Observed on a 335-row KRT: the model's reply was cut at the token limit,
 * leaving an unterminated ```json fence, JSON.parse died on the backtick, and
 * the retry wrapper tried four more times — 22 minutes, then an empty
 * suggestions panel with nothing to indicate anything had gone wrong.
 *
 * Same defect the KRT consolidation step had. These tests cover the parse side;
 * the token budget that stops it truncating in the first place is on the call.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const path = require('path');

// parseLMResponse is module-private; load the module with the symbol exposed.
const SRC = path.join(__dirname, 'kr-comparison.service.js');
const mod = new Module(SRC, null);
mod.filename = SRC;
mod.paths = Module._nodeModulePaths(path.dirname(SRC));
mod._compile(`${fs.readFileSync(SRC, 'utf8')}\nmodule.exports.__parse = parseLMResponse;`, SRC);
const parse = mod.exports.__parse;

const FENCE = '`'.repeat(3);

test('a truncated response keeps the decisions that completed', () => {
  const truncated = `${FENCE}json\n{\n "decisions": [\n`
    + '  {"ref":0,"action":"add","reason":"not in the KRT"},\n'
    + '  {"ref":1,"action":"skip","reason":"already present"},\n'
    + '  {"ref":2,"action":"add","reas';
  const decisions = parse(truncated);
  assert.equal(decisions.length, 2, 'the two complete decisions must survive');
  assert.deepEqual(decisions.map((d) => d.action), ['add', 'skip']);
});

test('a well-formed fenced response is unaffected', () => {
  const ok = `${FENCE}json\n{"decisions":[{"ref":0,"action":"add"}]}\n${FENCE}`;
  assert.equal(parse(ok).length, 1);
});

test('an unfenced response parses (responseMimeType json returns raw JSON)', () => {
  assert.equal(parse('{"decisions":[{"ref":0,"action":"add"}]}').length, 1);
});

test('a bare decisions array still parses', () => {
  assert.equal(parse('[{"ref":0,"action":"add"},{"ref":1,"action":"skip"}]').length, 2);
});

test('unrecoverable junk yields an empty list rather than throwing', () => {
  assert.deepEqual(parse('not json at all'), []);
  assert.deepEqual(parse(''), []);
});
