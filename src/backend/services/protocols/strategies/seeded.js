/**
 * Protocol detection, seeded from the author's KRT — what ships today.
 *
 * Unlike materials, this runs whether or not the author listed any protocols.
 * With no seeds the prompt's Section 0 has nothing to base on and the run is
 * article-only, which is dev's documented behaviour ("article-only, unchanged
 * behaviour") and has to stay that way.
 */

const path = require('path');
const fs = require('fs');
const { repoPath } = require('../../detection/repo-path');
const { loadAuthorSeeds } = require('../../krt/author-krt-seeds.service');
const { GROUP } = require('../../detection/resource-groups');

const PROMPT = path.join(__dirname, '../../../data/prompts/seeded/protocols-detection.txt');

module.exports = {
  id: 'protocols.seeded',
  promptFiles: [PROMPT],
  detector: 'protocols',
  seedTitle: 'protocols',

  async shouldRun() { return { run: true }; },

  async buildInput({ submissionId, round, options = {} }) {
    let seeds = await loadAuthorSeeds(submissionId, round, GROUP.protocol);
    if (typeof options.filterSeeds === 'function') seeds = seeds.filter(options.filterSeeds);
    return {
      prompt: fs.readFileSync(PROMPT, 'utf-8'),
      seeds,
      meta: { seedCount: seeds.length, promptFile: repoPath(PROMPT) }
    };
  }
};
