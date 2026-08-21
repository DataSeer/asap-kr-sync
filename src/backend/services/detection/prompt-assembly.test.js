/**
 * Characterization tests for model-input assembly.
 *
 * These pin the SHIPPED behaviour byte-for-byte, taken from dev's
 * materials/protocols/datasets services. They exist because the seeded path has
 * no other test coverage: nothing today asserts that seeds are loaded, that
 * they reach the prompt, or that the separators are what the prompts were tuned
 * against. Get any of it wrong and detection quietly changes with no failure.
 *
 * If one of these fails, the question is not "is the test stale" but "did we
 * just change every prompt the model has been tuned on".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ARTICLE_SEPARATOR,
  PAYLOAD_SEPARATOR,
  SEED_TITLES,
  seedBlock,
  assembleTextPrompt,
  assemblePayloadPrompt
} = require('./prompt-assembly');

// Shaped exactly as buildAuthorSeeds emits them.
const SEEDS = [
  { name: 'Chicken anti-GFP', role: 'REUSED', source: 'Invitrogen', accessions: [], dois: [], urls: [], additional_info: '' },
  { name: 'pAAV-CAG-GFP', role: 'GENERATED', source: 'Addgene', accessions: ['37825'], dois: [], urls: [], additional_info: 'gift' }
];

test('separators are exactly what the prompts were tuned against', () => {
  assert.equal(ARTICLE_SEPARATOR, '\n\n---\n\nARTICLE MARKDOWN:\n\n');
  assert.equal(PAYLOAD_SEPARATOR, '\n\nINPUT:\n');
  assert.equal(SEED_TITLES.materials, 'AUTHOR-PROVIDED MATERIALS (KRT):');
  assert.equal(SEED_TITLES.protocols, 'AUTHOR-PROVIDED PROTOCOLS (KRT):');
});

test('seedBlock: seeds are pretty-printed under the heading Section 0 reads', () => {
  const block = seedBlock(SEED_TITLES.materials, SEEDS);
  assert.equal(block, '\n\n---\n\nAUTHOR-PROVIDED MATERIALS (KRT):\n\n' + JSON.stringify(SEEDS, null, 2));
  assert.ok(block.includes('"name": "Chicken anti-GFP"'), 'seed rows must be readable in the prompt');
});

test('seedBlock: omitted ENTIRELY when there is nothing to seed', () => {
  // Not an empty heading — an article-only run has to be byte-identical to one
  // that never had a KRT at all.
  assert.equal(seedBlock(SEED_TITLES.materials, []), '');
  assert.equal(seedBlock(SEED_TITLES.materials, null), '');
  assert.equal(seedBlock(SEED_TITLES.materials, undefined), '');
});

test('materials: seeded assembly matches the shipped byte sequence', () => {
  const out = assembleTextPrompt({
    prompt: 'INSTRUCTIONS', seeds: SEEDS, seedTitle: SEED_TITLES.materials, markdownText: 'ARTICLE'
  });
  assert.equal(
    out,
    'INSTRUCTIONS'
    + '\n\n---\n\nAUTHOR-PROVIDED MATERIALS (KRT):\n\n' + JSON.stringify(SEEDS, null, 2)
    + '\n\n---\n\nARTICLE MARKDOWN:\n\n' + 'ARTICLE'
  );
});

test('protocols: same shape, its own heading', () => {
  const out = assembleTextPrompt({
    prompt: 'INSTRUCTIONS', seeds: SEEDS, seedTitle: SEED_TITLES.protocols, markdownText: 'ARTICLE'
  });
  assert.ok(out.includes('\n\n---\n\nAUTHOR-PROVIDED PROTOCOLS (KRT):\n\n'));
  assert.ok(out.endsWith('\n\n---\n\nARTICLE MARKDOWN:\n\nARTICLE'));
});

test('blind assembly: no seed title means no block, and the article still follows', () => {
  const out = assembleTextPrompt({ prompt: 'INSTRUCTIONS', markdownText: 'ARTICLE' });
  assert.equal(out, 'INSTRUCTIONS\n\n---\n\nARTICLE MARKDOWN:\n\nARTICLE');
  assert.ok(!out.includes('AUTHOR-PROVIDED'));
});

test('blind assembly: seeds are ignored when no title is given', () => {
  // A blind strategy must not be able to leak the KRT by passing seeds.
  const out = assembleTextPrompt({ prompt: 'I', seeds: SEEDS, markdownText: 'A' });
  assert.ok(!out.includes('Chicken anti-GFP'));
});

test('datasets: payload keys and their ORDER are part of the bytes', () => {
  const { prompt, payload } = assemblePayloadPrompt({
    systemPrompt: 'SYS', seeds: SEEDS, datasetNames: ['GSE1'], extractedRows: [{ a: 1 }], markdownText: 'ARTICLE'
  });
  assert.deepEqual(Object.keys(payload),
    ['author_provided_datasets', 'dataset_names', 'extracted_dataset_rows', 'full_article']);
  assert.equal(prompt, 'SYS\n\nINPUT:\n' + JSON.stringify(payload, null, 0));
  assert.ok(prompt.includes('"author_provided_datasets":[{"name":"Chicken anti-GFP"'));
});

test('datasets: author_provided_datasets is always present, empty when unseeded', () => {
  // Prompts that do not reference the key ignore it; a MISSING key breaks the
  // ones that do.
  const { payload } = assemblePayloadPrompt({
    systemPrompt: 'SYS', datasetNames: [], extractedRows: [], markdownText: 'A'
  });
  assert.deepEqual(payload.author_provided_datasets, []);
});

test('datasets: payload is minified, not pretty-printed', () => {
  const { prompt } = assemblePayloadPrompt({
    systemPrompt: 'SYS', seeds: [], datasetNames: [], extractedRows: [], markdownText: 'A'
  });
  assert.ok(!prompt.includes('\n  '), 'payload must be JSON.stringify(payload, null, 0)');
});
