/**
 * Dataset consolidation with no sight of the author's KRT.
 *
 * `author_provided_datasets` is still emitted in the payload, empty — the key
 * is always present so a prompt that references it cannot break.
 */

const path = require('path');
const fs = require('fs');

const PROMPT = path.join(__dirname, '../../../data/prompts/blind/datasets-consolidation.txt');
const SIGNALS_PROMPT = path.join(__dirname, '../../../data/prompts/blind/datasets-signals-extraction.txt');

module.exports = {
  id: 'datasets.blind',
  promptFiles: [PROMPT],
  detector: 'datasets',
  seedTitle: null,
  async shouldRun() { return { run: true }; },
  async buildInput() {
    return {
      prompt: fs.readFileSync(PROMPT, 'utf-8'),
      signalsPrompt: fs.readFileSync(SIGNALS_PROMPT, 'utf-8'),
      seeds: [],
      meta: { seedCount: 0 }
    };
  }
};
