/**
 * Materials detection with no sight of the author's KRT.
 *
 * Runs on every manuscript, including those with no KRT at all — which is the
 * point: the seeded strategy cannot discover anything for a submission whose
 * KRT has no materials, because it never runs there.
 */

const path = require('path');
const fs = require('fs');
const { repoPath } = require('../../detection/repo-path');

const PROMPT = path.join(__dirname, '../../../data/prompts/blind/materials-detection.txt');

module.exports = {
  id: 'materials.blind',
  promptFiles: [PROMPT],
  detector: 'materials',
  seedTitle: null,          // no title means the assembler emits no seed block

  async shouldRun() { return { run: true }; },

  async buildInput() {
    return {
      prompt: fs.readFileSync(PROMPT, 'utf-8'),
      seeds: [],
      meta: { seedCount: 0, promptFile: repoPath(PROMPT) }
    };
  }
};
