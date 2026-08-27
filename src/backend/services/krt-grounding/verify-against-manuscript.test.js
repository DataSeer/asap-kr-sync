/**
 * This module answers one question — does the paper print this identifier? —
 * and must not be tempted into answering a second.
 *
 * The second question, "is the author WRONG?", belongs to the matcher. When it
 * lived here it was answered by scanning the text around each mention for a
 * competing identifier of the same kind, which worked for typed identifiers and
 * missed everything else: `strain code: 400` against a paper reading
 * `strain code: 001` is no RRID, DOI or accession, so a plain contradiction two
 * words from the resource's name was reported as merely absent.
 *
 * What stays here is the part that is genuinely about corroboration, and the
 * property that made the original bug impossible to reintroduce: no curated
 * enrichment value can reach this comparison, because nothing but the author's
 * own parts is passed in.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { verdictFor, verifyRow } = require('./verify-against-manuscript');

test('an identifier the paper prints is found', () => {
  assert.equal(verdictFor({ value: 'RRID:SCR_014269', foundInText: true }).verdict, 'found');
});

test('an identifier the paper does not print is absent, with no correction attached', () => {
  // NOT an error. A KRT is allowed to carry more than the manuscript prints, and
  // most good tables do — the homepage of a tool is rarely in the methods. The
  // absence of a `competing` field is the point: this module never proposes a
  // change, because it has not established that anything is wrong.
  const v = verdictFor({ value: 'https://imagej.net/ij/plugins/time-series.html', foundInText: false });

  assert.equal(v.verdict, 'absent');
  assert.equal(v.competing, undefined);
});

test('the row that was wrongly flagged raises nothing now', () => {
  // The reported row. One value is verified, the other is simply not in the
  // paper — and neither is a defect, which is the whole point: the row was
  // right, and the app told the author it disagreed with the manuscript.
  const r = verifyRow({
    identifiers: [
      { value: 'https://imagej.net/ij/plugins/time-series.html', found: false },
      { value: 'RRID:SCR_014269', found: true }
    ]
  });

  assert.deepEqual(r.identifiers.map((v) => v.verdict), ['absent', 'found']);
  assert.deepEqual(r.unverified.map((u) => u.value), ['https://imagej.net/ij/plugins/time-series.html']);
});

test('an empty row yields no verdicts at all', () => {
  // "Nothing to check" is not "checked and not found".
  assert.deepEqual(verifyRow({ identifiers: [] }).identifiers, []);
  assert.deepEqual(verifyRow({}).identifiers, []);
});

test('nothing but the author own parts can reach this comparison', () => {
  // The decisive property. The original bug quoted curated enrichment values as
  // "the manuscript says"; this module is handed the author's identifiers and
  // their presence flags, and there is no parameter through which a candidate
  // or a curated list could arrive. That makes the failure unrepresentable
  // rather than merely fixed.
  const source = require('fs').readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!/candidate/i.test(code), 'no candidate value may enter the comparison');
  assert.ok(!/enrich/i.test(code), 'no enrichment value may enter the comparison');
});
