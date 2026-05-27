/**
 * Tests for the enrichment-list providers.
 *
 * dbProvider is exercised via the production code path; this file focuses on
 * the CSV provider, which is what benchmarks/snapshots actually use. Covers:
 *   - happy path: reads curated-<category>.csv and yields entries
 *   - missing CSV → empty array, no throw
 *   - `category` omitted → returns entries from all four categories
 *   - each entry carries `category` and `id` so downstream callers can filter
 *   - quoted fields with embedded commas survive the parser
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCsvProvider, VALID_CATEGORIES, dbProvider } = require('./enrichment-list-providers');

function tmpDirWithCsvs(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-providers-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('createCsvProvider throws when no dir given', () => {
  assert.throws(() => createCsvProvider(), /requires a directory/);
  assert.throws(() => createCsvProvider(null), /requires a directory/);
});

test('csv provider: happy path for one category', async () => {
  const dir = tmpDirWithCsvs({
    'curated-software.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      'Python,Software/code,python.org,py-id,reuse\n' +
      'R,Software/code,r-project.org,r-id,reuse\n'
  });
  const provider = createCsvProvider(dir);
  const entries = await provider.loadEntries('software');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].resourceName, 'Python');
  assert.equal(entries[0].category, 'software');
  assert.equal(entries[0].identifier, 'py-id');
  assert.ok(entries[0].id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('csv provider: missing file → empty array', async () => {
  const dir = tmpDirWithCsvs({}); // no CSVs at all
  const provider = createCsvProvider(dir);
  const entries = await provider.loadEntries('software');
  assert.deepEqual(entries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('csv provider: rows without identifier are skipped', async () => {
  const dir = tmpDirWithCsvs({
    'curated-software.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      'Python,Software/code,python.org,py-id,reuse\n' +
      'NoId,Software/code,nowhere,,reuse\n'  // identifier empty
  });
  const provider = createCsvProvider(dir);
  const entries = await provider.loadEntries('software');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resourceName, 'Python');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('csv provider: category omitted → loads all categories', async () => {
  const dir = tmpDirWithCsvs({
    'curated-software.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      'Python,Software/code,python.org,py-id,reuse\n',
    'curated-datasets.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      'GEO,Dataset,ncbi.nlm.nih.gov/geo,GSE12345,reuse\n',
    'curated-protocols.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      'WB,Protocol,protocols.io,doi:abc,reuse\n',
    'curated-materials.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      'Antibody,Lab Material,abcam,ab1791,reuse\n'
  });
  const provider = createCsvProvider(dir);
  const entries = await provider.loadEntries(); // no category arg
  assert.equal(entries.length, 4);
  // Each carries its category
  const cats = new Set(entries.map(e => e.category));
  assert.deepEqual([...cats].sort(), VALID_CATEGORIES.slice().sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('csv provider: quoted fields with embedded commas survive', async () => {
  const dir = tmpDirWithCsvs({
    'curated-software.csv':
      'resourceName,resourceType,source,identifier,newReuse\n' +
      '"Pandas, Inc",Software/code,pandas.io,pd-id,reuse\n'
  });
  const provider = createCsvProvider(dir);
  const entries = await provider.loadEntries('software');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].resourceName, 'Pandas, Inc');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dbProvider exposes name and loadEntries', () => {
  assert.equal(dbProvider.name, 'db');
  assert.equal(typeof dbProvider.loadEntries, 'function');
});
