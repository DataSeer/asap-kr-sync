/**
 * How model input is assembled, in one place.
 *
 * These are byte-exact reproductions of what the shipped pipeline does today.
 * They exist as their own module for one reason: the seeded and blind
 * strategies must differ ONLY in which prompt and which seeds they supply,
 * never in how those get glued together. Duplicating the glue per strategy is
 * how "the seeded path stopped seeding" becomes a silent bug — and the seeded
 * path has no test coverage at all today, so nothing would have caught it.
 *
 * The separators are load-bearing. Changing one changes every prompt the model
 * has ever been tuned against, so `prompt-assembly.test.js` pins them.
 */

/** Between the instructions (plus any seed block) and the manuscript. */
const ARTICLE_SEPARATOR = '\n\n---\n\nARTICLE MARKDOWN:\n\n';

/** Between the datasets system prompt and its JSON payload. */
const PAYLOAD_SEPARATOR = '\n\nINPUT:\n';

/** Headings the seeded prompts' Section 0 reads. Must match the prompt text. */
const SEED_TITLES = {
  materials: 'AUTHOR-PROVIDED MATERIALS (KRT):',
  protocols: 'AUTHOR-PROVIDED PROTOCOLS (KRT):'
};

/**
 * The author-seed block appended after the instructions.
 *
 * Omitted ENTIRELY when there are no seeds, rather than emitted empty: that is
 * what makes an article-only run byte-identical to one that never had a KRT,
 * and benchmarks depend on it.
 *
 * @param {string} title - one of SEED_TITLES
 * @param {object[]} seeds - from buildAuthorSeeds
 * @returns {string} '' when there is nothing to seed
 */
function seedBlock(title, seeds) {
  return Array.isArray(seeds) && seeds.length > 0
    ? `\n\n---\n\n${title}\n\n${JSON.stringify(seeds, null, 2)}`
    : '';
}

/**
 * Instructions + optional seed block + the manuscript. Used by materials and
 * protocols, which take the article as trailing text.
 *
 * @param {{prompt: string, seeds?: object[], seedTitle?: string, markdownText: string}} parts
 * @returns {string}
 */
function assembleTextPrompt({ prompt, seeds, seedTitle, markdownText }) {
  const block = seedTitle ? seedBlock(seedTitle, seeds) : '';
  return `${prompt}${block}${ARTICLE_SEPARATOR}${markdownText}`;
}

/**
 * Datasets consolidation takes a structured payload instead of trailing text,
 * and its prompt references the keys by name.
 *
 * `author_provided_datasets` is ALWAYS present — empty array when there is no
 * KRT — because prompts that do not reference the key simply ignore it, while a
 * missing key would break the ones that do. Key order is fixed: it is part of
 * the serialised bytes the model sees.
 *
 * @param {{systemPrompt: string, seeds?: object[], datasetNames: string[], extractedRows: object[], markdownText: string}} parts
 * @returns {{prompt: string, payload: object}}
 */
function assemblePayloadPrompt({ systemPrompt, seeds, datasetNames, extractedRows, markdownText }) {
  const payload = {
    author_provided_datasets: Array.isArray(seeds) ? seeds : [],
    dataset_names: datasetNames,
    extracted_dataset_rows: extractedRows,
    full_article: markdownText
  };
  return { prompt: `${systemPrompt}${PAYLOAD_SEPARATOR}${JSON.stringify(payload, null, 0)}`, payload };
}

module.exports = {
  ARTICLE_SEPARATOR,
  PAYLOAD_SEPARATOR,
  SEED_TITLES,
  seedBlock,
  assembleTextPrompt,
  assemblePayloadPrompt
};
