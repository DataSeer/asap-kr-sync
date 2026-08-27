'use strict';

/**
 * A run says whether it ran with its own parameters or today's.
 *
 * A restart already used frozen INPUTS — the manuscript and KRT the round
 * settled on — but today's prompt and today's model. So a re-run that disagreed
 * with the original could not be told apart from a prompt somebody had edited
 * in between, which is exactly the question a re-run is usually asked to
 * settle.
 *
 * `params_source` records the choice:
 *
 *   live    today's prompts and config. The default, and what every run so far
 *           did — nothing is backfilled to `frozen`, because none of them were.
 *   frozen  the parameters the parent run's execution used, merged over the
 *           live config so a secret that was never recorded still resolves.
 *
 * On the RUN rather than per step: it is one choice for one restart, and a run
 * where half the steps used old prompts is not something anyone asked for.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('pipeline_runs');
    if (!table.params_source) {
      await queryInterface.addColumn('pipeline_runs', 'params_source', {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'live'
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('pipeline_runs');
    if (table.params_source) {
      await queryInterface.removeColumn('pipeline_runs', 'params_source');
    }
  }
};
