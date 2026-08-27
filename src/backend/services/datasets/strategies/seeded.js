/**
 * Dataset consolidation, seeded from the author's KRT — what ships today.
 *
 * Datasets differ from materials and protocols in HOW the seeds travel: they go
 * into the `author_provided_datasets` field of the JSON payload the
 * consolidation prompt reads by name, not into a block appended after the
 * instructions. `seedTitle` is therefore null — the assembler must not emit a
 * text block — and the detector places the seeds in the payload instead.
 *
 * Runs with or without seeds: prompts that do not reference the key ignore it.
 */

const path = require('path');
const fs = require('fs');
const { repoPath } = require('../../detection/repo-path');
const { loadAuthorSeeds } = require('../../krt/author-krt-seeds.service');
const { GROUP } = require('../../detection/resource-groups');
const { JOB_TYPES } = require('../../../config/constants');

const PROMPT = path.join(__dirname, '../../../data/prompts/seeded/datasets-consolidation.txt');
const SIGNALS_PROMPT = path.join(__dirname, '../../../data/prompts/seeded/datasets-signals-extraction.txt');
// The few-shot examples LangExtract is given. As much an input as the
// prompt is — edit it and the signals change — so it is declared and
// recorded like one.
const SIGNALS_EXAMPLES = path.join(__dirname, '../../../data/prompts/datasets-signals-examples.json');

module.exports = {
  id: 'datasets.seeded',
  promptFiles: [PROMPT],
  // Declared separately, and checked for existence alongside promptFiles.
  // Omitting it entirely made detectionPromptsExist report the module
  // available with this file missing — buildInput then threw ENOENT and
  // the module served demo rows for a real manuscript. It is not in
  // `promptFiles` because it produces SIGNALS, not resource records: its
  // grounding is LangExtract's span alignment, not an evidence field.
  signalsPromptFiles: [SIGNALS_PROMPT],
  detector: 'datasets',
  seedTitle: null,

  async shouldRun() { return { run: true }; },

  async buildInput({ submissionId, round, options = {} }) {
    let seeds = await loadAuthorSeeds(submissionId, round, GROUP.dataset, { jobType: JOB_TYPES.DATASETS_DETECTION });
    if (typeof options.filterSeeds === 'function') seeds = seeds.filter(options.filterSeeds);
    return {
      prompt: fs.readFileSync(PROMPT, 'utf-8'),
      signalsPrompt: fs.readFileSync(SIGNALS_PROMPT, 'utf-8'),
      seeds,
      meta: {
        seedCount: seeds.length,
        promptFile: repoPath(PROMPT),
        signalsPromptFile: repoPath(SIGNALS_PROMPT),
        signalsExamplesFile: repoPath(SIGNALS_EXAMPLES)
      }
    };
  }
};
