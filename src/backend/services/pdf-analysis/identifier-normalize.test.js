/**
 * Tests for identifier normalization helper.
 * Run with: node --test src/backend/services/pdf-analysis/identifier-normalize.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRawValue,
  normalizeName,
  canonicalResourceType,
  extractIdentifierTokens,
  identifiersMatch,
  namesMatch,
  computeDedupKey
} = require('./identifier-normalize.service');

// ---------- normalizeRawValue ----------

test('normalizeRawValue: lowercases + trims', () => {
  assert.equal(normalizeRawValue('  Hello World  '), 'hello world');
});

test('normalizeRawValue: strips https/http/www/doi.org prefix', () => {
  assert.equal(normalizeRawValue('https://doi.org/10.5281/zenodo.X'), '10.5281/zenodo.x');
  assert.equal(normalizeRawValue('http://www.example.com/x'), 'example.com/x');
});

test('normalizeRawValue: strips DOI:, RRID:, PMID: prefixes', () => {
  assert.equal(normalizeRawValue('DOI: 10.1234/abc'), '10.1234/abc');
  assert.equal(normalizeRawValue('RRID: AB_2744623'), 'ab_2744623');
  assert.equal(normalizeRawValue('PMID: 12345'), '12345');
});

test('normalizeRawValue: strips trailing punctuation', () => {
  assert.equal(normalizeRawValue('10.1234/abc.'), '10.1234/abc');
  assert.equal(normalizeRawValue('10.1234/abc/'), '10.1234/abc');
  assert.equal(normalizeRawValue('10.1234/abc; '), '10.1234/abc');
});

test('normalizeRawValue: handles SCR_ prefix conversion', () => {
  assert.equal(normalizeRawValue('SCR: 002798'), 'scr_002798');
  assert.equal(normalizeRawValue('SCR_002798'), 'scr_002798');
});

test('normalizeRawValue: handles null/undefined/empty', () => {
  assert.equal(normalizeRawValue(null), '');
  assert.equal(normalizeRawValue(undefined), '');
  assert.equal(normalizeRawValue(''), '');
});

// ---------- normalizeName ----------

test('normalizeName: lowercases + collapses whitespace', () => {
  assert.equal(normalizeName('Python  3.10'), 'python 3.10');
});

test('normalizeName: strips surrounding punctuation', () => {
  assert.equal(normalizeName('"Python"'), 'python');
  assert.equal(normalizeName('(GitHub)'), 'github');
});

// ---------- extractIdentifierTokens ----------

test('extractIdentifierTokens: extracts typed tokens', () => {
  const t = extractIdentifierTokens('https://doi.org/10.5281/zenodo.X');
  assert.ok(t.has('doi:10.5281/zenodo.x'));
});

test('extractIdentifierTokens: handles multi-id field', () => {
  const t = extractIdentifierTokens('Cat#: N0502-At488-L ; RRID: AB_2744623');
  assert.ok(t.has('rrid:ab_2744623'), 'should extract RRID');
  // catalog number extraction depends on the regex — just verify RRID is there
});

test('extractIdentifierTokens: empty input → empty set', () => {
  assert.equal(extractIdentifierTokens('').size, 0);
  assert.equal(extractIdentifierTokens(null).size, 0);
});

// ---------- identifiersMatch ----------

test('identifiersMatch: same DOI in different shapes → match', () => {
  assert.ok(identifiersMatch('https://doi.org/10.5281/zenodo.X', '10.5281/zenodo.x'));
  assert.ok(identifiersMatch('DOI: 10.5281/zenodo.X.', 'doi.org/10.5281/zenodo.X'));
});

test('identifiersMatch: same RRID in different shapes → match', () => {
  assert.ok(identifiersMatch('RRID: AB_2744623', 'AB_2744623'));
  assert.ok(identifiersMatch('rrid: ab_2744623', 'RRID:AB_2744623'));
});

test('identifiersMatch: multi-id field matching one of them', () => {
  assert.ok(identifiersMatch(
    'Cat#: N0502 ; RRID: AB_2744623',
    'AB_2744623'
  ));
});

test('identifiersMatch: different IDs of same type → no match', () => {
  assert.ok(!identifiersMatch('10.1234/abc', '10.5678/xyz'));
  assert.ok(!identifiersMatch('AB_111', 'AB_222'));
});

test('identifiersMatch: opaque string fallback when no structured ids', () => {
  assert.ok(identifiersMatch('PRJEB1234', 'PRJEB1234'));
  assert.ok(identifiersMatch('PRJEB1234', 'prjeb1234'));
  assert.ok(!identifiersMatch('PRJEB1234', 'PRJEB9999'));
});

test('identifiersMatch: empty fields → no match', () => {
  assert.ok(!identifiersMatch('', ''));
  assert.ok(!identifiersMatch('10.1234/abc', ''));
});

// ---------- namesMatch ----------

test('namesMatch: case insensitive', () => {
  assert.ok(namesMatch('Python', 'python'));
  assert.ok(namesMatch('Cell Ranger', 'cell ranger'));
});

test('namesMatch: whitespace tolerant', () => {
  assert.ok(namesMatch('  Python  ', 'Python'));
});

test('namesMatch: empty → no match', () => {
  assert.ok(!namesMatch('', ''));
  assert.ok(!namesMatch('Python', ''));
});

// ---------- computeDedupKey ----------

test('computeDedupKey: stable across input shapes', () => {
  const k1 = computeDedupKey({
    resourceType: 'Software/code',
    resourceName: 'Python',
    newReuse: 'reuse',
    identifier: 'https://doi.org/10.1234/abc'
  });
  const k2 = computeDedupKey({
    resourceType: 'code/software',
    resourceName: 'PYTHON',
    newReuse: 'REUSE',
    identifier: 'DOI: 10.1234/abc.'
  });
  assert.equal(k1, k2);
});

test('computeDedupKey: different new/reuse → different keys', () => {
  const base = { resourceType: 'Software/code', resourceName: 'Python', identifier: '' };
  assert.notEqual(
    computeDedupKey({ ...base, newReuse: 'new' }),
    computeDedupKey({ ...base, newReuse: 'reuse' })
  );
});

test('computeDedupKey: identifier wins over name when present', () => {
  // Same identifier, different names → same key (shouldn't happen with rule 3, but
  // dedup_key should prefer the identifier so different-name dups can collapse).
  const k1 = computeDedupKey({
    resourceType: 'X', newReuse: 'new',
    resourceName: 'Foo', identifier: '10.1234/abc'
  });
  const k2 = computeDedupKey({
    resourceType: 'X', newReuse: 'new',
    resourceName: 'Bar', identifier: '10.1234/abc'
  });
  assert.equal(k1, k2);
});

test('computeDedupKey: no identifier → uses name', () => {
  const k1 = computeDedupKey({
    resourceType: 'X', newReuse: 'new',
    resourceName: 'Python', identifier: ''
  });
  const k2 = computeDedupKey({
    resourceType: 'X', newReuse: 'new',
    resourceName: 'PYTHON', identifier: null
  });
  assert.equal(k1, k2);
});

// ---------- canonicalResourceType ----------

test('canonicalResourceType: collapses Code/Software variants to "Software/code"', () => {
  assert.equal(canonicalResourceType('Code/Software'), 'Software/code');
  assert.equal(canonicalResourceType('code/software'), 'Software/code');
  assert.equal(canonicalResourceType('Software/code'), 'Software/code');
  assert.equal(canonicalResourceType('software/code'), 'Software/code');
  assert.equal(canonicalResourceType('Code'),          'Software/code');
  assert.equal(canonicalResourceType('software'),      'Software/code');
});

test('canonicalResourceType: unknown types pass through trimmed (case preserved)', () => {
  assert.equal(canonicalResourceType('Antibody'),                            'Antibody');
  assert.equal(canonicalResourceType('Dataset'),                             'Dataset');
  assert.equal(canonicalResourceType('  Experimental model: Cell line '),    'Experimental model: Cell line');
  assert.equal(canonicalResourceType('Recombinant DNA'),                     'Recombinant DNA');
});

test('canonicalResourceType: empty / null / undefined → empty string', () => {
  assert.equal(canonicalResourceType(''),         '');
  assert.equal(canonicalResourceType('   '),      '');
  assert.equal(canonicalResourceType(null),       '');
  assert.equal(canonicalResourceType(undefined),  '');
});
