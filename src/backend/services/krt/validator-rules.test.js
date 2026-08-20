/**
 * The KRT rules, from the curator's side: what BLOCKS and what merely warns.
 *
 * This distinction is the whole contract of the validation step. An error stops
 * the submission at "Continue"; a warning does not. Getting one wrong is not a
 * cosmetic bug — promoting a warning blocks work that should proceed, and
 * demoting an error ships a table nobody checked.
 *
 * `validateRowValues` is the DB-free core that both the app and
 * `scripts/check-krt.js` run, so these cases hold for the upload path, the
 * editor, and the offline tooling at once.
 *
 * (`validateSource` has its own file for the Software/code exemption, and
 * report-changes has its own. This covers the rest.)
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRowValues,
  validateResourceType,
  validateResourceName,
  validateIdentifierValues,
  validateNewReuse,
  normalizeResourceType,
  DEFAULT_RESOURCE_TYPES
} = require('./validator.service');

/** A row that passes everything, so each test can break exactly one thing. */
const good = (over = {}) => ({
  resourceType: 'Antibody',
  resourceName: 'anti-TagFP',
  source: 'Evrogen',
  identifier: 'RRID:AB_2313584',
  newReuse: 'reuse',
  additionalInformation: '',
  ...over
});

const errors = (list) => list.filter((e) => e.severity === 'error');
const warnings = (list) => list.filter((e) => e.severity === 'warning');
const columns = (list) => list.map((e) => e.columnName);
const types = (list) => list.map((e) => e.errorType);

// ─────────────────────────────────────────────────────────────────────────────
// The baseline: a good row is silent
// ─────────────────────────────────────────────────────────────────────────────

test('a complete, well-formed row produces nothing at all', () => {
  assert.deepEqual(validateRowValues(good()), []);
});

test('the four required columns each block on their own', () => {
  for (const column of ['resourceType', 'resourceName', 'identifier', 'newReuse']) {
    const found = errors(validateRowValues(good({ [column]: '' })));
    assert.equal(found.length, 1, `${column} empty must produce exactly one error`);
    assert.equal(found[0].errorType, 'required');
  }
});

test('whitespace is not a value', () => {
  for (const column of ['resourceName', 'newReuse']) {
    const found = errors(validateRowValues(good({ [column]: '   ' })));
    assert.equal(found.length, 1, `${column} of spaces must still be required`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// "N/A" — the answer that looks filled in and is not
// ─────────────────────────────────────────────────────────────────────────────

test('N/A is refused wherever a real value is required', () => {
  for (const variation of ['N/A', 'n/a', 'NA', 'na', 'none', 'N.A.', '-']) {
    const found = errors(validateRowValues(good({ resourceName: variation })));
    assert.ok(found.length >= 1, `"${variation}" must not pass as a resource name`);
    assert.equal(found[0].errorType, 'na_not_allowed');
  }
});

test('N/A in the identifier blocks, unless the row is marked optional', () => {
  assert.equal(errors(validateRowValues(good({ identifier: 'N/A' }))).length, 1);
  assert.deepEqual(validateRowValues(good({ identifier: 'N/A', isOptional: true })), [],
    'an optional row may legitimately have no identifier');
});

test('the two accepted escape hatches are accepted', () => {
  // These say "we looked and there is nothing", which is a real answer.
  for (const phrase of ['No identifier exists', 'Identifier pending']) {
    assert.deepEqual(validateRowValues(good({ identifier: phrase })), [],
      `"${phrase}" must be accepted as written`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Resource type
// ─────────────────────────────────────────────────────────────────────────────

test('a resource type outside the configured list is refused', () => {
  const found = errors(validateResourceType('Invented type', 'row-1', DEFAULT_RESOURCE_TYPES));
  assert.equal(found.length, 1);
  assert.equal(found[0].columnName, 'RESOURCE TYPE');
});

test('every default resource type validates against its own list', () => {
  for (const type of DEFAULT_RESOURCE_TYPES) {
    assert.deepEqual(validateResourceType(type, 'row-1', DEFAULT_RESOURCE_TYPES), [],
      `"${type}" is in the default list and must validate`);
  }
});

test('the configured list wins over the defaults', () => {
  // A deployment that defines its own types must not be judged by the defaults.
  assert.deepEqual(validateResourceType('Local type', 'row-1', ['Local type']), []);
  assert.equal(errors(validateResourceType('Antibody', 'row-1', ['Local type'])).length, 1);
});

test('normalizeResourceType folds the plurals and synonyms curators actually type', () => {
  assert.equal(normalizeResourceType('antibodies'), 'Antibody');
  assert.equal(normalizeResourceType('Antibody'), 'Antibody');
  assert.equal(normalizeResourceType('  ANTIBODIES  '), 'Antibody');
  assert.equal(normalizeResourceType('chemicals'), 'Chemical, peptide, or recombinant protein');
  assert.equal(normalizeResourceType('bacterial strains'), 'Bacterial strain');
});

test('normalizeResourceType returns null for nothing, rather than a bare string', () => {
  assert.equal(normalizeResourceType(''), null);
  assert.equal(normalizeResourceType(null), null);
  assert.equal(normalizeResourceType(undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Resource name
// ─────────────────────────────────────────────────────────────────────────────

test('a very long name warns but does not block', () => {
  const found = validateResourceName('x'.repeat(501), 'row-1');
  assert.equal(errors(found).length, 0, 'length must never stop a submission');
  assert.equal(warnings(found).length, 1);
  assert.equal(warnings(found)[0].errorType, 'max_length');
});

test('a name at the limit is fine', () => {
  assert.deepEqual(validateResourceName('x'.repeat(500), 'row-1'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Identifier — the rules with the most room to be wrong
// ─────────────────────────────────────────────────────────────────────────────

test('a DOI, an RRID and a URL are all accepted', () => {
  for (const [type, identifier] of [
    ['Dataset', '10.5281/zenodo.16885839'],
    ['Antibody', 'RRID:AB_2313584'],
    ['Software/code', 'https://github.com/example/tool'],
    ['Software/code', 'RRID:SCR_023953']
  ]) {
    assert.deepEqual(
      validateIdentifierValues({ identifier, resourceType: type }), [],
      `${identifier} must be accepted for ${type}`
    );
  }
});

test('an unrecognized identifier warns — it does not block', () => {
  // The app not recognising a string is not proof the author is wrong.
  const found = validateIdentifierValues({ identifier: 'internal-ref-42', resourceType: 'Antibody' });
  assert.equal(errors(found).length, 0);
  assert.equal(warnings(found)[0].errorType, 'invalid_format');
});

test('a bare repository accession warns, and says to give the record instead', () => {
  const found = validateIdentifierValues({ identifier: 'GSE12345', resourceType: 'Dataset' });
  assert.equal(errors(found).length, 0);
  assert.equal(warnings(found)[0].errorType, 'accession_not_persistent');
  assert.match(warnings(found)[0].suggestion, /DOI|URL/);
});

test('an identifier hiding in Additional Information is reported as misplaced', () => {
  const found = validateIdentifierValues({
    identifier: '',
    additionalInformation: 'See RRID:AB_2313584 for details',
    resourceType: 'Antibody'
  });
  assert.equal(errors(found).length, 0, 'the identifier exists — this is a move, not a gap');
  assert.equal(warnings(found)[0].errorType, 'missing_but_found');
});

test('an empty identifier with nothing in Additional Information blocks', () => {
  const found = validateIdentifierValues({ identifier: '', additionalInformation: 'no id here', resourceType: 'Antibody' });
  assert.equal(errors(found).length, 1);
  assert.equal(errors(found)[0].errorType, 'required');
});

test('an optional row is never blocked for a missing identifier', () => {
  assert.deepEqual(
    validateIdentifierValues({ identifier: '', resourceType: 'Antibody', isOptional: true }), []
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// protocols.io — the rule that catches a replaced hyperlink
// ─────────────────────────────────────────────────────────────────────────────

test('a protocols.io row with free text instead of a link is flagged', () => {
  const found = validateRowValues(good({
    resourceType: 'Protocol', source: 'protocols.io', identifier: 'see supplementary methods'
  }));
  // Asserted on the rule's own errorType, not merely "something about the
  // identifier" — an OR that wide would pass on any unrelated identifier
  // complaint and prove nothing.
  assert.ok(found.some((e) => /protocols/i.test(e.errorType)),
    `replacing the protocol link with prose must raise the protocols.io rule; got ${JSON.stringify(types(found))}`);
});

test('a protocols.io row with a DOI is accepted', () => {
  const found = validateRowValues(good({
    resourceType: 'Protocol', source: 'protocols.io', identifier: '10.17504/protocols.io.abc123'
  }));
  assert.deepEqual(errors(found), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW / REUSE
// ─────────────────────────────────────────────────────────────────────────────

test('new and reuse are accepted in any casing', () => {
  for (const value of ['new', 'NEW', 'New', 'reuse', 'REUSE', ' Reuse ']) {
    assert.deepEqual(validateNewReuse(value, 'row-1'), [], `"${value}" must be accepted`);
  }
});

test('anything else in NEW/REUSE blocks', () => {
  for (const value of ['recycled', 'both', 'yes', '1']) {
    assert.equal(errors(validateNewReuse(value, 'row-1')).length, 1, `"${value}" must be refused`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The row as a whole
// ─────────────────────────────────────────────────────────────────────────────

test('every error carries the row id it belongs to', () => {
  // Without this the editor cannot point at the offending row.
  const found = validateRowValues(good({ rowId: 'row-42', resourceName: '', identifier: 'N/A', newReuse: '' }));
  assert.ok(found.length >= 3);
  for (const e of found) assert.equal(e.rowId, 'row-42');
});

test('every error names its column and carries a severity', () => {
  const found = validateRowValues(good({ resourceType: '', resourceName: '', identifier: '', newReuse: '' }));
  for (const e of found) {
    assert.ok(e.columnName, 'an error with no column cannot be shown against a cell');
    assert.ok(['error', 'warning'].includes(e.severity), `unexpected severity ${e.severity}`);
    assert.ok(e.errorMessage, 'an error with no message tells the curator nothing');
  }
});

test('a completely empty row reports every required column, not just the first', () => {
  const found = errors(validateRowValues({}));
  const reported = new Set(columns(found));
  for (const column of ['RESOURCE TYPE', 'RESOURCE NAME', 'IDENTIFIER', 'NEW/REUSE']) {
    assert.ok(reported.has(column), `${column} must be reported on an empty row`);
  }
});

test('validateRowValues survives being handed nothing', () => {
  assert.ok(Array.isArray(validateRowValues()));
  assert.ok(Array.isArray(validateRowValues({}, [])), 'an empty type list falls back to the defaults');
});

test('no rule ever reports the same problem twice on one row', () => {
  // Double-flagging one cell reads as two separate faults to fix.
  const found = validateRowValues(good({ source: 'protocols.io', resourceType: 'Protocol', identifier: '' }));
  const seen = new Set();
  for (const e of found) {
    const key = `${e.columnName}|${e.errorType}`;
    assert.ok(!seen.has(key), `duplicate report: ${key}`);
    seen.add(key);
  }
});

test('the identifier rules do not fire on the phrases that opt out of them', () => {
  const found = validateRowValues(good({ source: 'protocols.io', resourceType: 'Protocol', identifier: 'No identifier exists' }));
  assert.equal(types(found).filter((t) => t.startsWith('invalid') || t.includes('protocols')).length, 0);
});
