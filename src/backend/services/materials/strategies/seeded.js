/**
 * Materials detection, seeded from the author's KRT — what ships today.
 *
 * A strategy decides WHAT to ask the model. It never calls the model, parses a
 * response, or builds KRT items: the detector owns all of that, once, for every
 * strategy.
 */

const path = require('path');
const fs = require('fs');
const { loadAuthorSeeds } = require('../../krt/author-krt-seeds.service');
const { GROUP } = require('../../detection/resource-groups');

const PROMPT = path.join(__dirname, '../../../data/prompts/seeded/materials-detection.txt');

module.exports = {
  id: 'materials.seeded',
  promptFiles: [PROMPT],
  detector: 'materials',
  seedTitle: 'materials',

  /**
   * Materials detection is author-seeded ONLY: with no author materials there
   * is nothing to re-ground, and the prompt's whole framing ("RE-GROUND and
   * lightly ENRICH them, not re-derive a list from scratch") does not apply.
   *
   * This gate belongs to the STRATEGY, not the detector. Put it on the detector
   * and the blind strategy inherits a rule that contradicts it — and it fails
   * silently, as materials simply returning nothing.
   */
  async shouldRun({ submissionId, round }) {
    const seeds = await loadAuthorSeeds(submissionId, round, GROUP.material);
    return seeds.length > 0
      ? { run: true }
      : { run: false, reason: 'seeded strategy: the author KRT contains no lab materials' };
  },

  async buildInput({ submissionId, round, options = {} }) {
    let seeds = await loadAuthorSeeds(submissionId, round, GROUP.material);
    if (typeof options.filterSeeds === 'function') seeds = seeds.filter(options.filterSeeds);
    return {
      prompt: fs.readFileSync(PROMPT, 'utf-8'),
      seeds,
      meta: { seedCount: seeds.length }
    };
  }
};
