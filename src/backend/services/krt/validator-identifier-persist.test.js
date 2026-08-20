/**
 * What validation WRITES BACK to the row.
 *
 * `validateIdentifier` is the DB-backed twin of `validateIdentifierValues`, and
 * it does something the pure one does not: it parses the identifiers out of the
 * cell and persists them on the row as `parsedIdentifiers`. Report generation
 * reads that field to surface "extra information we found about this resource",
 * so a row validated but not written, or written with the wrong shape, produces
 * a report that quietly omits things the author supplied.
 *
 * The row is a stub with a `save()` — enough to observe both what is stored and
 * whether it was stored at all.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateIdentifier } = require('./validator.service');

/** A KRT row as the validator mutates it. */
function row(over = {}) {
  return {
    id: 'row-1',
    resourceType: 'Antibody',
    resourceName: 'anti-TagFP',
    identifier: '',
    additionalInformation: '',
    isOptional: false,
    saveCount: 0,
    async save() { this.saveCount++; return this; },
    ...over
  };
}

const errorsOf = (list) => list.filter((e) => e.severity === 'error');

// ─────────────────────────────────────────────────────────────────────────────
// The escape hatches — a real answer, recorded as one
// ─────────────────────────────────────────────────────────────────────────────

test('"Identifier pending" is recorded as pending, not as a parsed identifier', async () => {
  const r = row({ identifier: 'Identifier pending' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.deepEqual(errors, []);
  assert.deepEqual(r.parsedIdentifiers, { identifierPending: true });
  assert.equal(r.saveCount, 1, 'the verdict has to be persisted, not just returned');
});

test('"No identifier exists" is recorded as such', async () => {
  const r = row({ identifier: 'No identifier exists' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.deepEqual(errors, []);
  assert.deepEqual(r.parsedIdentifiers, { noIdentifier: true });
  assert.equal(r.saveCount, 1);
});

test('the escape hatches are matched regardless of case and padding', async () => {
  for (const value of ['IDENTIFIER PENDING', '  Identifier Pending  ', 'no identifier exists']) {
    const r = row({ identifier: value });
    const errors = await validateIdentifier(r, 'sub-1');
    assert.deepEqual(errorsOf(errors), [], `"${value}" must be accepted`);
    assert.ok(r.parsedIdentifiers, `"${value}" must still be recorded`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// N/A
// ─────────────────────────────────────────────────────────────────────────────

test('N/A blocks, and nothing is written', async () => {
  const r = row({ identifier: 'N/A' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.equal(errorsOf(errors).length, 1);
  assert.equal(errors[0].errorType, 'na_not_allowed');
  assert.equal(r.saveCount, 0, 'a rejected value must not be recorded as a parsed identifier');
});

test('N/A on an Optional row is accepted and stored as nothing found', async () => {
  const r = row({ identifier: 'N/A', isOptional: true });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.deepEqual(errors, []);
  assert.deepEqual(r.parsedIdentifiers, {});
  assert.equal(r.saveCount, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// What gets parsed out and kept
// ─────────────────────────────────────────────────────────────────────────────

test('a recognised identifier is parsed onto the row', async () => {
  const r = row({ identifier: 'RRID:AB_2313584' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.deepEqual(errorsOf(errors), []);
  assert.ok(r.parsedIdentifiers, 'the parse must be stored for the report to read');
  assert.equal(r.saveCount, 1);
});

test('a DOI on a dataset row is accepted and parsed', async () => {
  const r = row({ resourceType: 'Dataset', identifier: '10.5281/zenodo.16885839' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.deepEqual(errorsOf(errors), []);
  assert.ok(Object.values(r.parsedIdentifiers).some(Boolean), 'the DOI must survive as a parsed value');
});

test('an identifier found only in Additional Information is MOVED into the column', async () => {
  // Auto-copy: authors paste RRIDs and DOIs into Additional Information without
  // recognising them as identifiers. This rewrites the author's own cell, so it
  // is worth being explicit that it happens and what it copies.
  const r = row({ identifier: '', additionalInformation: 'Catalogue RRID:AB_2313584, lot 3' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.equal(errorsOf(errors).length, 0, 'a findable identifier is not a block');
  assert.equal(r.identifier, 'RRID:AB_2313584', 'the value must land in the IDENTIFIER column');
  assert.ok(Object.values(r.parsedIdentifiers).some(Boolean));
  assert.equal(r.saveCount, 1, 'the move and its parse are one write, not two');
});

test('auto-copy only takes a value that suits the resource type', async () => {
  // An antibody row must not have a dataset accession moved into its
  // identifier: the copy would be worse than the gap it fills.
  const r = row({ resourceType: 'Antibody', identifier: '', additionalInformation: 'deposited as GSE12345' });

  await validateIdentifier(r, 'sub-1');

  assert.equal(r.identifier, '', 'nothing suitable was found, so nothing may be copied');
});

test('the IDENTIFIER column wins over Additional Information', async () => {
  // Both carry an RRID; the column the author filled in deliberately is the
  // authoritative one.
  const r = row({
    identifier: 'RRID:AB_1111111',
    additionalInformation: 'previously RRID:AB_9999999'
  });

  await validateIdentifier(r, 'sub-1');

  const stored = JSON.stringify(r.parsedIdentifiers);
  assert.match(stored, /AB_1111111/);
  assert.doesNotMatch(stored, /AB_9999999/, 'the fallback must not override the real column');
});

test('every path through the validator leaves the row saved exactly once', async () => {
  // Two saves would double a write on every row of every KRT; zero means the
  // parse is computed and thrown away.
  const cases = [
    { identifier: 'RRID:AB_2313584' },
    { identifier: 'Identifier pending' },
    { identifier: 'No identifier exists' },
    { identifier: 'N/A', isOptional: true },
    { identifier: '', additionalInformation: 'RRID:AB_2313584' },
    { identifier: 'something unrecognised' }
  ];

  for (const over of cases) {
    const r = row(over);
    await validateIdentifier(r, 'sub-1');
    assert.equal(r.saveCount, 1, `${JSON.stringify(over)} saved ${r.saveCount} times`);
  }
});

test('an empty row with nothing anywhere blocks, and is not written', async () => {
  const r = row({ identifier: '', additionalInformation: '' });

  const errors = await validateIdentifier(r, 'sub-1');

  assert.equal(errorsOf(errors).length, 1);
  assert.equal(errors[0].errorType, 'required');
});
