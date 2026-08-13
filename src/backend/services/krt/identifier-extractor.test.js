/**
 * Regression tests for two identifier patterns that made UNRELATED resources
 * compare as equal. Both were silent: nothing threw, and the matcher simply
 * agreed with itself about the wrong thing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { identifiersMatch, extractIdentifierTokens } =
  require('../pdf-analysis/identifier-normalize.service');

test('a repository RRID keeps the part after the SECOND colon', () => {
  // `RRID:IMSR_JAX:000664` used to capture only "IMSR_JAX", so every JAX mouse
  // strain produced an identical token and the matcher treated all of them as
  // the same animal.
  const tokens = [...extractIdentifierTokens('RRID:IMSR_JAX:000664')];
  assert.ok(tokens.some((t) => t.includes('000664')), `strain number lost: ${tokens}`);
});

test('two different JAX strains do not match', () => {
  assert.equal(identifiersMatch('RRID:IMSR_JAX:000664', 'RRID: IMSR_JAX:028862'), false);
});

test('the same JAX strain still matches across spacing and case', () => {
  assert.equal(identifiersMatch('RRID:IMSR_JAX:000664', 'rrid: imsr_jax:000664'), true);
});

test('plain RRIDs are unaffected', () => {
  assert.equal(identifiersMatch('RRID:AB_2744623', 'RRID: ab_2744623'), true);
  assert.equal(identifiersMatch('RRID:Addgene_62934', 'RRID:Addgene_62988'), false);
  assert.equal(identifiersMatch('RRID:SCR_003070', 'RRID:SCR_003070'), true);
});

test('a DOI does not yield a GenBank token', () => {
  // The GenBank pattern was case-insensitive, so "s41592" inside
  // 10.1038/s41592-… looked like an accession and two unrelated Nature-family
  // DOIs shared a token.
  const tokens = [...extractIdentifierTokens('10.1038/s41592-019-0582-9')];
  assert.ok(!tokens.some((t) => t.startsWith('genbank:')), `spurious token: ${tokens}`);
});

test('two different DOIs do not match', () => {
  assert.equal(
    identifiersMatch('doi.org/10.1038/s41592-019-0582-9', '10.1038/s41592-019-0619-0'),
    false
  );
});

test('a real (uppercase) GenBank accession is still recognised', () => {
  const tokens = [...extractIdentifierTokens('AB123456')];
  assert.ok(tokens.some((t) => t.startsWith('genbank:')), `accession lost: ${tokens}`);
});
