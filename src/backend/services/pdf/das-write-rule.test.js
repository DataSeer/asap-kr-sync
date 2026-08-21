/**
 * Whose Availability Statement wins when extraction runs again.
 *
 * Two fields, two meanings:
 *
 *   - `extractedDataAvailabilityStatement` is what the last extraction found,
 *     always overwritten;
 *   - `dataAvailabilityStatement` is what the submission stands on, filled from
 *     extraction only while it is empty.
 *
 * The bug this pins: extraction wrote the second field every time,
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

test('re-extraction does not overwrite a field that is already filled', () => {
  // Even though nobody edited it: once the working field holds a statement, it
  // belongs to whoever put it there, and the app cannot tell a statement the
  // author read and accepted from one they never looked at.
  //
  // The newer reading is not lost — it goes to the extracted field, and the
  // page shows the two side by side when they differ.
  const submission = untouched();

  const outcome = applyExtractedDas(submission, 'Data are at Dryad, accession 12345.');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo.');
  assert.equal(submission.extractedDataAvailabilityStatement, 'Data are at Dryad, accession 12345.');
  assert.equal(outcome.replaced, false);
});

test('"Not found" does not count as filled', () => {
  // Extraction is fail-soft and always persists something, so a first pass that
  // found nothing leaves the sentinel in the working field. Treating that as
  // occupied would lock out every later extraction — including the one that
  // finally succeeds after the manuscript is re-uploaded.
  const submission = untouched(NO_DAS_SENTINEL);

  applyExtractedDas(submission, 'Data are at Zenodo.');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo.');
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
  // The case the two fields exist for: extraction has something to say this
  // time, and it is still not the author's text to overwrite.
  const submission = untouched('Data are at Zenodo.');
  submission.dataAvailabilityStatement = 'Data are at Zenodo, DOI 10.5281/zenodo.1.';

  applyExtractedDas(submission, 'Data available on request.');

  assert.equal(submission.dataAvailabilityStatement, 'Data are at Zenodo, DOI 10.5281/zenodo.1.');
  assert.equal(submission.extractedDataAvailabilityStatement, 'Data available on request.',
    'the new reading is still recorded — it is just not promoted over a person');
});

test('a filled statement keeps its confirmation', () => {
  // Extraction running again changed nothing the author agreed to, so making
  // them agree again would be noise — and would park the Availability check
  // awaiting input for a reason no user could see.
  const submission = untouched(NO_DAS_SENTINEL);
  submission.dataAvailabilityStatement = 'All data are in the supplement.';

  const outcome = applyExtractedDas(submission, NO_DAS_SENTINEL);

  assert.equal(submission.dasConfirmedAt, CONFIRMED);
  assert.equal(outcome.confirmationWithdrawn, false);
});

test('filling an empty field withdraws any confirmation standing over it', () => {
  // Extractor-authored text has nobody behind it. A confirmation left from
  // earlier words does not carry over — the check would report on a statement
  // nobody has read, in the author's name.
  const submission = untouched(NO_DAS_SENTINEL);

  const outcome = applyExtractedDas(submission, 'Data available on request.');

  assert.equal(submission.dasConfirmedAt, null);
  assert.equal(submission.dasConfirmedByUserId, null);
  assert.equal(outcome.confirmationWithdrawn, true);
});

test('a blank field is filled, whatever shape the blank is', () => {
  // '', null and undefined all mean "nothing there". Any of them freezing
  // extraction out would leave the submission with no statement at all.
  for (const blank of ['', '   ', null, undefined]) {
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

test('the extracted field is always updated, filled or not', () => {
  // It is the record of what the extractor said on this run. A reader comparing
  // the two fields is asking "did the manuscript change?", and a stale
  // extracted value answers a question about some earlier run instead.
  const filled = untouched();
  applyExtractedDas(filled, 'Data available on request.');
  assert.equal(filled.extractedDataAvailabilityStatement, 'Data available on request.');

  const empty = { extractedDataAvailabilityStatement: 'old', dataAvailabilityStatement: '', dasConfirmedAt: null };
  applyExtractedDas(empty, 'Data available on request.');
  assert.equal(empty.extractedDataAvailabilityStatement, 'Data available on request.');
});
