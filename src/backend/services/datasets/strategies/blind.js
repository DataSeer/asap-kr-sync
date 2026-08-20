/**
 * Dataset consolidation with no sight of the author's KRT.
 *
 * `author_provided_datasets` is still emitted in the payload, empty — the key
 * is always present so a prompt that references it cannot break.
 */

const path = require('path');
const fs = require('fs');
const { repoPath } = require('../../detection/repo-path');

const PROMPT = path.join(__dirname, '../../../data/prompts/blind/datasets-consolidation.txt');
const SIGNALS_PROMPT = path.join(__dirname, '../../../data/prompts/blind/datasets-signals-extraction.txt');

module.exports = {
  id: 'datasets.blind',
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
  async buildInput() {
    return {
      prompt: fs.readFileSync(PROMPT, 'utf-8'),
      signalsPrompt: fs.readFileSync(SIGNALS_PROMPT, 'utf-8'),
      seeds: [],
      meta: { seedCount: 0, promptFile: repoPath(PROMPT), signalsPromptFile: repoPath(SIGNALS_PROMPT) }
    };
  }
};
