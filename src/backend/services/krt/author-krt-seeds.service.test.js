/**
 * Tests for the shared author-KRT seeding helpers (pure functions).
 * loadAuthorSeeds hits the DB and is exercised via integration.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitKrtIdentifiers, buildAuthorSeeds } = require('./author-krt-seeds.service');

test('splitKrtIdentifiers: classifies accessions, DOIs, URLs', () => {
  const out = splitKrtIdentifiers('GSE236732; https://protocols.io/x 10.17504/protocols.io.abc doi:10.1/abc');
  assert.deepEqual(out.accessions, ['GSE236732']);
  assert.deepEqual(out.urls, ['https://protocols.io/x']);
  assert.deepEqual(out.dois, ['10.17504/protocols.io.abc', '10.1/abc']);
});

test('splitKrtIdentifiers: empty / null → empty buckets', () => {
  assert.deepEqual(splitKrtIdentifiers(''), { accessions: [], dois: [], urls: [] });
  assert.deepEqual(splitKrtIdentifiers(null), { accessions: [], dois: [], urls: [] });
});

test('buildAuthorSeeds: maps rows; reuse→REUSED; harvests URL from additional info; drops nameless', () => {
  const seeds = buildAuthorSeeds([
    { resourceName: 'RNA extraction', source: 'protocols.io', identifier: '10.17504/protocols.io.abc', newReuse: 'new', additionalInformation: 'core method' },
    { resourceName: 'Staining', source: 'Smith 2020', identifier: '', newReuse: 'reuse', additionalInformation: 'see https://protocols.io/y' },
    { resourceName: '', source: 'x', identifier: 'y', newReuse: 'new', additionalInformation: '' }
  ]);
  assert.equal(seeds.length, 2);
  assert.deepEqual(seeds[0], {
    name: 'RNA extraction', role: 'GENERATED', source: 'protocols.io',
    accessions: [], dois: ['10.17504/protocols.io.abc'], urls: [], additional_info: 'core method'
  });
  assert.equal(seeds[1].role, 'REUSED');
  assert.deepEqual(seeds[1].urls, ['https://protocols.io/y']);
});

test('buildAuthorSeeds: empty / non-array → []', () => {
  assert.deepEqual(buildAuthorSeeds([]), []);
  assert.deepEqual(buildAuthorSeeds(null), []);
});
