const test = require('node:test');
const assert = require('node:assert');

const {
  scanPublishedProtocols,
  trimIdentifier
} = require('./published-protocol-scanner.service');

const {
  buildKrtItemsPublishedProtocol
} = require('./identifier-detection.service');

// ---------- trimIdentifier ----------

test('trimIdentifier: strips trailing sentence punctuation', () => {
  assert.equal(trimIdentifier('10.3791/61234.'),   '10.3791/61234');
  assert.equal(trimIdentifier('10.3791/61234),'),  '10.3791/61234');
  assert.equal(trimIdentifier('10.3791/61234];'),  '10.3791/61234');
  assert.equal(trimIdentifier('  10.3791/61234 '), '10.3791/61234');
});

test('trimIdentifier: preserves case and URL scheme', () => {
  assert.equal(
    trimIdentifier('https://www.Nature.com/articles/nprot.2009.97'),
    'https://www.Nature.com/articles/nprot.2009.97'
  );
});

// ---------- scanPublishedProtocols: the 10 detectable venues ----------

test('scanPublishedProtocols: every venue detectable by DOI', () => {
  const text = `
    Methods used 10.17504/protocols.io.764hrgw and 10.3791/61234 alongside
    10.1016/j.xpro.2021.100442 and 10.1016/j.mex.2020.100921. We also followed
    10.21769/bioprotoc.4604, the preprint 10.21769/p9999, 10.1002/cpz1.336,
    10.1101/pdb.prot5448, 10.1038/nprot.2009.97 and 10.1038/protex.2017.015.
  `;
  const { matches } = scanPublishedProtocols(text);
  const bySource = Object.fromEntries(matches.map(m => [m.source, m.identifier]));

  assert.equal(bySource['protocols.io'],               '10.17504/protocols.io.764hrgw');
  assert.equal(bySource['JoVE'],                       '10.3791/61234');
  assert.equal(bySource['STAR Protocols'],             '10.1016/j.xpro.2021.100442');
  assert.equal(bySource['MethodsX'],                   '10.1016/j.mex.2020.100921');
  assert.equal(bySource['Bio-protocol'],               '10.21769/bioprotoc.4604');
  assert.equal(bySource['Bio-protocol Preprint'],      '10.21769/p9999');
  assert.equal(bySource['Current Protocols'],          '10.1002/cpz1.336');
  assert.equal(bySource['Cold Spring Harbor Protocols'], '10.1101/pdb.prot5448');
  assert.equal(bySource['Nature Protocols'],           '10.1038/nprot.2009.97');
  assert.equal(bySource['Protocol Exchange'],          '10.1038/protex.2017.015');
  assert.equal(matches.length, 10);
});

test('scanPublishedProtocols: venues detectable by URL', () => {
  const text = `
    See https://www.protocols.io/view/abc and https://www.jove.com/v/61234/title
    plus https://www.cell.com/star-protocols/fulltext/S2666 and
    https://bio-protocol.org/e4604 , https://bio-protocol.org/p9999 ,
    https://currentprotocols.onlinelibrary.wiley.com/doi/10.1002/x ,
    http://cshprotocols.cshlp.org/content/2019/2/x ,
    https://www.nature.com/articles/s41596-021-00566-6 and
    https://protocolexchange.researchsquare.com/article/pex-1234/v1
  `;
  const { matches } = scanPublishedProtocols(text);
  const sources = new Set(matches.map(m => m.source));

  for (const expected of [
    'protocols.io', 'JoVE', 'STAR Protocols', 'Bio-protocol',
    'Bio-protocol Preprint', 'Current Protocols',
    'Cold Spring Harbor Protocols', 'Nature Protocols', 'Protocol Exchange'
  ]) {
    assert.ok(sources.has(expected), `expected venue ${expected} to be detected`);
  }
});

// ---------- the N/A path ----------

test('scanPublishedProtocols: ordinary article / data / code identifiers ignored', () => {
  const text = `
    Data at 10.5281/zenodo.123456 and code at https://github.com/foo/bar.
    Published in 10.1038/s41586-020-2649-2 and preprinted at
    10.1101/2020.01.01.123456. See also https://osf.io/abcde/ and GSE12345.
  `;
  const { matches } = scanPublishedProtocols(text);
  assert.deepEqual(matches, []);
});

test('scanPublishedProtocols: ambiguous protocol-publisher prefixes ignored', () => {
  // Each of these IS sometimes a protocol, but the identifier alone cannot
  // prove it — the prefix is shared with ordinary articles/chapters.
  const text = `
    10.1371/journal.pbio.3001450 and 10.1007/978-1-0716-1084-8_5 and
    10.1385/1-59259-192-2:123 and 10.2144/000113917 and legacy
    10.21203/rs.3.pex-1234/v1.
  `;
  const { matches } = scanPublishedProtocols(text);
  assert.deepEqual(matches, []);
});

// ---------- punctuation & dedup ----------

test('scanPublishedProtocols: trailing punctuation is not swallowed', () => {
  const inSentence = scanPublishedProtocols('as described in 10.1038/nprot.2009.97.');
  assert.equal(inSentence.matches[0].identifier, '10.1038/nprot.2009.97');

  const inParens = scanPublishedProtocols('the method (10.3791/61234) was used.');
  assert.equal(inParens.matches[0].identifier, '10.3791/61234');
});

test('scanPublishedProtocols: repeat mentions collapse to one match', () => {
  const text = `
    We used 10.3791/61234 for staining. Later, 10.3791/61234 was repeated,
    see also https://doi.org/10.3791/61234 for the video.
  `;
  const { matches } = scanPublishedProtocols(text);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, 'JoVE');
});

test('scanPublishedProtocols: matches are ordered by first occurrence', () => {
  const text = 'first 10.3791/61234 then 10.1038/nprot.2009.97 last.';
  const { matches } = scanPublishedProtocols(text);
  assert.deepEqual(matches.map(m => m.source), ['JoVE', 'Nature Protocols']);
});

// ---------- cutoff ----------

test('scanPublishedProtocols: cutoff truncates the scanned body', () => {
  const body = 'Methods cite 10.3791/61234. ';
  const text = body + 'References: 10.1038/nprot.2009.97';
  const { matches } = scanPublishedProtocols(text, { cutoff: body.length });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, 'JoVE');
});

test('scanPublishedProtocols: empty / non-string input', () => {
  assert.deepEqual(scanPublishedProtocols('').matches, []);
  assert.deepEqual(scanPublishedProtocols(null).matches, []);
  assert.deepEqual(scanPublishedProtocols(undefined).matches, []);
  assert.deepEqual(scanPublishedProtocols(42).matches, []);
});

// ---------- buildKrtItemsPublishedProtocol ----------

test('buildKrtItemsPublishedProtocol: emits Protocol rows with venue as SOURCE', () => {
  const md = 'The staining used 10.1038/nprot.2009.97 throughout.';
  const { matches } = scanPublishedProtocols(md);
  const items = buildKrtItemsPublishedProtocol(matches, md);

  assert.equal(items.length, 1);
  assert.equal(items[0].resourceType, 'Protocol');
  assert.equal(items[0].identifier,   '10.1038/nprot.2009.97');
  assert.equal(items[0].source,       'Nature Protocols');
  assert.equal(items[0].origin,       'protocol-venue-scan');
  assert.equal(items[0].detectorMeta.category, 'protocols');
  assert.equal(items[0].detectorMeta.relevance, 'HIGH');
  assert.ok(items[0].detectorMeta.context.includes('nprot'));
});

test('buildKrtItemsPublishedProtocol: never guesses a name or new/reuse', () => {
  const md = 'Deposited at 10.17504/protocols.io.764hrgw for this study.';
  const items = buildKrtItemsPublishedProtocol(scanPublishedProtocols(md).matches, md);
  // The identifier proves WHERE it was published, not who authored it — the
  // author may well have deposited their own new protocol.
  assert.equal(items[0].resourceName, '');
  assert.equal(items[0].newReuse, '');
});

test('buildKrtItemsPublishedProtocol: non-array input → empty', () => {
  assert.deepEqual(buildKrtItemsPublishedProtocol(null, ''), []);
  assert.deepEqual(buildKrtItemsPublishedProtocol(undefined, ''), []);
});
