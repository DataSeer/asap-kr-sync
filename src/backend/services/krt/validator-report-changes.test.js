'use strict';

/**
 * Tests for the KRT validation changes requested in the ASAP report evaluations
 * (curator "AY"): identifier-acceptance rules, resource-type synonym mapping,
 * and the Optional-row identifier bug. All exercised through the pure, DB-free
 * validator core (validateIdentifierValues / normalizeResourceType).
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateIdentifierValues, normalizeResourceType } = require('./validator.service');
const extractor = require('./identifier-extractor');

const TYPE_CHEM = 'Chemical, peptide, or recombinant protein';

function has(errors, errorType) {
  return errors.some(e => e.errorType === errorType);
}

// ── Bare RRIDs (no "RRID:" prefix) ─────────────────────────────────────────
test('bare authority-scoped RRID (AB_2617428) is accepted for a lab material', () => {
  const errors = validateIdentifierValues({ identifier: 'AB_2617428', resourceType: 'Antibody' });
  assert.equal(errors.length, 0);
});

test('prefixed RRID (RRID:AB_2617428) is still accepted', () => {
  const errors = validateIdentifierValues({ identifier: 'RRID:AB_2617428', resourceType: 'Antibody' });
  assert.equal(errors.length, 0);
});

test('an arbitrary word_word token is NOT treated as a bare RRID', () => {
  assert.equal(extractor.extractRRID('foo_bar123'), null);
});

// ── SCR / RRID for Tools & Instruments (mapped to "Other") ─────────────────
test('SCR code is accepted for Other (Tools/Instruments)', () => {
  const errors = validateIdentifierValues({ identifier: 'RRID:SCR_016499', resourceType: 'Other' });
  assert.equal(errors.length, 0);
});

// ── Chemicals: CAS numbers ─────────────────────────────────────────────────
test('CAS registry number (144-55-8) is accepted for a Chemical', () => {
  const errors = validateIdentifierValues({ identifier: '144-55-8', resourceType: TYPE_CHEM });
  assert.equal(errors.length, 0);
});

test('catalog extraction defers to CAS so the CAS number is not misread', () => {
  assert.equal(extractor.extractCatalogNumber('144-55-8'), null);
  assert.equal(extractor.extractCAS('144-55-8'), '144-55-8');
});

// ── Accessions: advise DOI/URL instead of flat rejection ───────────────────
test('a bare repository accession (GSE12345) yields the DOI/URL advisory', () => {
  const errors = validateIdentifierValues({ identifier: 'GSE12345', resourceType: 'Dataset' });
  assert.equal(has(errors, 'accession_not_persistent'), true);
  assert.match(errors[0].suggestion, /DOI or URL/);
});

// ── "No RRID available" wording for Software ────────────────────────────────
test('"No RRID available" is an accepted escape hatch (no error)', () => {
  for (const val of ['No RRID available', 'no rrid available', 'No RRID']) {
    const errors = validateIdentifierValues({ identifier: val, resourceType: 'Software/code' });
    assert.equal(errors.length, 0, `expected no error for "${val}"`);
  }
});

// ── Optional-row identifier bug ─────────────────────────────────────────────
test('an empty identifier on an Optional row does not raise the required error', () => {
  const errors = validateIdentifierValues({ identifier: '', resourceType: 'Antibody', isOptional: true });
  assert.equal(errors.length, 0);
});

test('an "n/a" identifier on an Optional row does not raise the na error', () => {
  const errors = validateIdentifierValues({ identifier: 'n/a', resourceType: 'Antibody', isOptional: true });
  assert.equal(errors.length, 0);
});

test('an empty identifier on a NON-optional row still raises the required error', () => {
  const errors = validateIdentifierValues({ identifier: '', resourceType: 'Antibody', isOptional: false });
  assert.equal(has(errors, 'required'), true);
});

// ── Chemicals: lenient catalog identifiers ─────────────────────────────────
test('a letters-only / letters+few-digits catalog code is accepted for Chemicals', () => {
  for (const val of ['ab290', 'ABCDEF', 'Cat# ab290', 'sc-32233']) {
    const errors = validateIdentifierValues({ identifier: val, resourceType: TYPE_CHEM });
    assert.equal(errors.length, 0, `expected no error for chemical identifier "${val}"`);
  }
});

test('the lenient chemical rule does not apply to other resource types', () => {
  const errors = validateIdentifierValues({ identifier: 'ab290', resourceType: 'Antibody' });
  assert.equal(has(errors, 'invalid_format'), true);
});

test('multi-word prose is still flagged even for Chemicals', () => {
  const errors = validateIdentifierValues({ identifier: 'see methods section', resourceType: TYPE_CHEM });
  assert.equal(has(errors, 'invalid_format'), true);
});

// ── Resource-type synonym mapping ───────────────────────────────────────────
test('author resource-type synonyms map to canonical types', () => {
  const cases = {
    'Commercial assay or kit': 'Critical commercial assay',
    'Biological reagents': TYPE_CHEM,
    'Peptide': TYPE_CHEM,
    'Bacteria': 'Bacterial strain',
    'Instrument': 'Other',
    'Resource': 'Other',
    'Tools': 'Other',
    'Genetic reagent (Mus musculus)': 'Experimental model: Organism/strain',
    'Virus strain': 'Viral vector'
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeResourceType(input), expected, `${input} → ${expected}`);
  }
});
