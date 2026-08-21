/**
 * Whose Availability Statement wins when extraction runs again.
 *
 * The bug this pins: extraction wrote `dataAvailabilityStatement` every time,
 * unconditionally. An author whose statement the extractor could not find typed
 * one by hand — the whole reason the manual path exists — and the next run of
 * extraction replaced it with "Not found". The app undid their work and called
 * it an update, silently, with no record that anything had been lost.
 *
 * Run with: node --test src/backend/services/pdf/das-write-rule.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyExtractedDas } = require('./pdf.service');
const { NO_DAS_SENTINEL } = require('../das-suggestions/das-suggestions.service');

const CONFIRMED = new Date('2026-08-20T09:00:00Z');

/** A submission as it exists after a previous extraction the author left alone. */
function untouched(extraction = 'Data are at Zenodo.') {
  return {
    extractedDataAvailabilityStatement: extraction,
    dataAvailabilityStatement: extraction,
    dasConfirmedAt: CONFIRMED,
    dasConfirmedByUserId: 'user-1'
  };
}

test('a fresh extraction fills an empty submission', () => {
  const submission = {
    extractedDataAvailabilityStatement: null,
    dataAvailabilityStatement: null,
    dasConfirmedAt: null,
    dasConfirmedByUserId: null
  };

  const outcome = applyExtractedDas(submission, 'Data are at Zenodo.');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo.');
  assert.equal(submission.extractedDataAvailabilityStatement, 'Data are at Zenodo.');
  assert.equal(outcome.replaced, true);
});

test('re-extraction may correct its own previous answer', () => {
  // Nobody has touched it, so there is no human decision to protect — the newer
  // reading of the manuscript is simply better.
  const submission = untouched();

  applyExtractedDas(submission, 'Data are at Dryad, accession 12345.');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Dryad, accession 12345.');
});

test('re-extraction does NOT overwrite what the author typed', () => {
  const submission = untouched(NO_DAS_SENTINEL);
  submission.dataAvailabilityStatement = 'All data are in the supplement.';

  const outcome = applyExtractedDas(submission, NO_DAS_SENTINEL);

  assert.equal(submission.dataAvailabilityStatement, 'All data are in the supplement.',
    'the author supplied this precisely because extraction could not');
  assert.equal(outcome.replaced, false);
});

test('and it does not overwrite an author correction with a better guess either', () => {
  // The stronger case: extraction has something to say this time. It is still
  // not the author's to overwrite — it goes to the extracted field, which is
  // what that field is for.
  const submission = untouched('Data are at Zenodo.');
  submission.dataAvailabilityStatement = 'Data are at Zenodo, DOI 10.5281/zenodo.1.';

  applyExtractedDas(submission, 'Data available on request.');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo, DOI 10.5281/zenodo.1.');
  assert.equal(submission.extractedDataAvailabilityStatement, 'Data available on request.',
    'the new reading is still recorded — it is just not promoted over a person');
});

test('an author edit keeps its confirmation', () => {
  // The author confirmed their own text. Extraction running again changed
  // nothing they agreed to, so making them agree again would be noise.
  const submission = untouched(NO_DAS_SENTINEL);
  submission.dataAvailabilityStatement = 'All data are in the supplement.';

  const outcome = applyExtractedDas(submission, NO_DAS_SENTINEL);

  assert.equal(submission.dasConfirmedAt, CONFIRMED);
  assert.equal(outcome.confirmationWithdrawn, false);
});

test('new extracted text withdraws the confirmation', () => {
  // What the author agreed to is gone. Re-confirming is one click; a report
  // about a statement nobody has read is not recoverable.
  const submission = untouched();

  const outcome = applyExtractedDas(submission, 'Data available on request.');

  assert.equal(submission.dasConfirmedAt, null);
  assert.equal(submission.dasConfirmedByUserId, null);
  assert.equal(outcome.confirmationWithdrawn, true);
});

test('re-extraction landing on the same text keeps the confirmation', () => {
  // A re-run that produces an identical statement has not changed the subject
  // of the agreement, so it must not silently invalidate it — that would park
  // the Availability check awaiting input for no reason a user could see.
  const submission = untouched();

  const outcome = applyExtractedDas(submission, 'Data are at Zenodo.');

  assert.equal(submission.dasConfirmedAt, CONFIRMED);
  assert.equal(outcome.confirmationWithdrawn, false);
});

test('an empty statement is not an author edit', () => {
  // '' and null both mean "nothing there", and neither is a decision worth
  // protecting — otherwise a blanked field would freeze extraction out for good.
  for (const blank of ['', null, undefined]) {
    const submission = {
      extractedDataAvailabilityStatement: 'Data are at Zenodo.',
      dataAvailabilityStatement: blank,
      dasConfirmedAt: null,
      dasConfirmedByUserId: null
    };

    applyExtractedDas(submission, 'Data are at Dryad.');

    assert.equal(submission.dataAvailabilityStatement, 'Data are at Dryad.',
      `${JSON.stringify(blank)} must not lock extraction out`);
  }
});
