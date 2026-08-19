/**
 * Materials detection under a seeded pipeline.
 *
 * A strategy decides WHAT to ask the model. It never calls the model, parses a
 * response, or builds KRT items: the detector owns all of that, once, for every
 * strategy.
 *
 * With seeds, this is dev's behaviour exactly: the seeded prompt, framed as
 * "re-ground and lightly enrich the rows you were given", plus the author's
 * material rows.
 *
 * WITHOUT seeds it falls back to discovery rather than refusing to run. Dev
 * skipped materials entirely for a submission whose KRT lists no materials,
 * which left the module with zero capacity in exactly the case that needs it
 * most — a manuscript submitted with no KRT at all. The fallback is not a
 * behaviour change for anyone who has materials in their KRT; it is capability
 * where there was previously nothing.
 *
 * The prompt has to change with it. A seeded prompt handed an empty seed list
 * still reads "do not re-derive a materials list from scratch", which is an
 * instruction to find nothing.
 */

const path = require('path');
const fs = require('fs');
const { loadAuthorSeeds } = require('../../krt/author-krt-seeds.service');
const { GROUP } = require('../../detection/resource-groups');

const SEEDED_PROMPT = path.join(__dirname, '../../../data/prompts/seeded/materials-detection.txt');
const DISCOVERY_PROMPT = path.join(__dirname, '../../../data/prompts/blind/materials-detection.txt');

module.exports = {
  id: 'materials.seeded',
  detector: 'materials',
  seedTitle: 'materials',
  promptFiles: [SEEDED_PROMPT, DISCOVERY_PROMPT],

  /** Always. With no seeds it discovers instead — see the note above. */
  async shouldRun() { return { run: true }; },

  async buildInput({ submissionId, round, options = {} }) {
    let seeds = await loadAuthorSeeds(submissionId, round, GROUP.material);
    if (typeof options.filterSeeds === 'function') seeds = seeds.filter(options.filterSeeds);

    // No seeds → the seeded prompt would instruct the model to enrich a list
    // that does not exist, and to add sparingly on top of it.
    const seeded = seeds.length > 0;
    return {
      prompt: fs.readFileSync(seeded ? SEEDED_PROMPT : DISCOVERY_PROMPT, 'utf-8'),
      seeds,
      meta: { seedCount: seeds.length, mode: seeded ? 'seeded' : 'discovery' }
    };
  }
};
