/**
 * The grounding check may only cite the manuscript for things the manuscript says.
 *
 * It did not. `compareWithCandidates` compared the author's cell against
 * `supplier.candidate[field]` and labelled the result `manuscriptValue` — and
 * for an `identifier-scan` candidate that field comes from the curated
 * enrichment list, not the text. So a curator was shown "the manuscript says",
 * followed by values the paper had never contained.
 *
 * The real example, from a live submission. Four values presented as the
 * manuscript's; three of them appear nowhere in it:
 *
 *     RRID:SCR_014269                                     in the text
 *     http://ric.uthscsa.edu/mango/                       NOT
 *     https://imagej.net/ij/plugins/time-series.html      NOT
 *     https://imagej.nih.gov/ij/plugins/time-series.html  NOT
 *
 * The row was correct and was flagged `Incoherence`. Two of the three conflicts
 * on that instance were of this kind — a check that is wrong more often than it
 * is right, and wrong in the direction of telling people to break good data.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { verdictFor, kindOf, verifyRow } = require('./verify-against-manuscript');

// The methods sentence as the conversion actually produced it — escaped.
const METHODS = 'Live-cell images were analyzed using the ImageJ plug-in '
  + 'Time Series Analyzer V3 (RRID:SCR\\_014269), where 20 to 30 circular regions '
  + 'of interest (ROIs) of radius ~ 1 um corresponding to synaptic boutons';

const say = (value, foundInText, context = METHODS) => verdictFor({ value, foundInText, context });

// ─────────────────────────────────────────────────────────────────────────────
// The three verdicts
// ─────────────────────────────────────────────────────────────────────────────

test('an identifier the paper prints is found', () => {
  assert.equal(say('RRID:SCR_014269', true).verdict, 'found');
});

test('an identifier the paper does not print, with nothing contradicting it, is absent', () => {
  // NOT an error. A KRT is allowed to carry more than the manuscript prints, and
  // most good tables do — the homepage of a tool is rarely in the methods.
  const v = say('https://imagej.net/ij/plugins/time-series.html', false);

  assert.equal(v.verdict, 'absent');
  assert.equal(v.competing, undefined, 'nothing may be offered as a correction');
});

test('an identifier contradicted by a different one of the SAME kind is a possible mismatch', () => {
  const v = say('RRID:SCR_999999', false);

  assert.equal(v.verdict, 'possible_mismatch');
  assert.equal(v.competing, 'RRID:SCR_014269', 'and it names what it saw');
});

// ─────────────────────────────────────────────────────────────────────────────
// What must NOT become a mismatch
// ─────────────────────────────────────────────────────────────────────────────

test('a different KIND of identifier nearby is not a disagreement', () => {
  // The author gave a DOI; the paper has an RRID. Those are different claims,
  // and comparing them manufactures a conflict out of two unrelated facts.
  const v = say('10.5281/zenodo.14203629', false);

  assert.equal(v.verdict, 'absent');
});

test('the same value written differently is found, not a mismatch', () => {
  // The conversion escapes identifiers (`SCR\\_014269`), and comparing the two
  // spellings as strings is how a correct row gets reported as wrong.
  assert.equal(say('RRID:SCR_014269', false).verdict, 'found');
  assert.equal(say('rrid:scr_014269', false).verdict, 'found');
});

test('a row never located in the text yields absent, not a mismatch', () => {
  // With no mentions there is no neighbourhood, so nothing has been compared and
  // nothing may be asserted.
  assert.equal(verdictFor({ value: 'RRID:SCR_999999', foundInText: false, context: '' }).verdict, 'absent');
});

test('a value that is not an identifier at all is absent', () => {
  assert.equal(say('see supplementary table 3', false).verdict, 'absent');
});

// ─────────────────────────────────────────────────────────────────────────────
// Kinds
// ─────────────────────────────────────────────────────────────────────────────

test('identifier kinds are told apart', () => {
  assert.equal(kindOf('RRID:SCR_014269'), 'rrid');
  assert.equal(kindOf('10.1234/abc'), 'doi');
  assert.equal(kindOf('https://example.org/tool'), 'url');
  assert.equal(kindOf('not an identifier'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The reported row, end to end
// ─────────────────────────────────────────────────────────────────────────────

test('the row that was wrongly flagged raises nothing now', () => {
  // Both of the author's values, against the real sentence. One is verified, the
  // other is simply not in the paper — and neither is a conflict, which is the
  // whole point: the author's row was right.
  const index = { text: METHODS };
  const mentions = [{ offset: METHODS.indexOf('Time Series') }];

  const r = verifyRow({
    identifiers: [
      { value: 'https://imagej.net/ij/plugins/time-series.html', found: false },
      { value: 'RRID:SCR_014269', found: true }
    ],
    index,
    mentions
  });

  assert.equal(r.mismatches.length, 0, 'no disagreement exists, so none may be reported');
  assert.equal(r.unverified.length, 1);
  assert.deepEqual(r.identifiers.map((v) => v.verdict), ['absent', 'found']);
});

test('the enrichment values that caused this are never consulted', () => {
  // The decisive property: this module is given the manuscript and the author's
  // row, and nothing else. There is no parameter through which a curated list
  // could reach it, which is what makes the old failure unrepresentable rather
  // than merely fixed.
  const source = require('fs').readFileSync(__filename.replace('.test.js', '.js'), 'utf8');

  assert.ok(!/candidate/i.test(source.replace(/^[\s*/]*\*.*$/gm, '')),
    'no candidate value may enter the comparison');
});
