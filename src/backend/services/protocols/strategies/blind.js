/**
 * Protocol detection with no sight of the author's KRT.
 */

const path = require('path');
const fs = require('fs');

const PROMPT = path.join(__dirname, '../../../data/prompts/blind/protocols-detection.txt');

module.exports = {
  id: 'protocols.blind',
  promptFiles: [PROMPT],
  detector: 'protocols',
  seedTitle: null,
  async shouldRun() { return { run: true }; },
  async buildInput() {
    return { prompt: fs.readFileSync(PROMPT, 'utf-8'), seeds: [], meta: { seedCount: 0 } };
  }
};
