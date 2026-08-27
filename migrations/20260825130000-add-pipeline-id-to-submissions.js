'use strict';

/**
 * Which detection pipeline a submission was analysed with.
 *
 * `config/pipelines.js` has defined `seeded-v1` and `blind-v1` since the
 * strategies landed, and three services already resolve their behaviour from
 * `submission.pipelineId` — but nothing ever stored one, so every submission
 * silently resolved to the default and `blind-v1` was unreachable. The registry
 * was wired at one end only.
 *
 * Nullable, but new rows are always stamped by the controller — including with
 * the default, which is written out rather than left implicit. `getPipeline()`
 * resolves an empty id to whatever the default is *now*, so a null row would
 * silently start claiming it ran a different pipeline the day the default
 * changes. What a submission was analysed with is a fact about the past, and
 * the same reasoning already produced frozen prompts and frozen call
 * parameters.
 *
 * NULL therefore means one thing only: a row created before this column
 * existed, whose pipeline nobody recorded. No backfill — inventing 'seeded-v1'
 * for those would assert something nothing witnessed.
 *
 * Not a foreign key, and not an enum. The pipelines are code, not data — they
 * carry strategies, merge policy and grounding flags that only make sense as
 * literals in the registry. The controller validates against `getPipeline()`,
 * which throws on an unknown id rather than falling back, because a fallback
 * would detect differently and say nothing.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('submissions');
    if (!table.pipeline_id) {
      await queryInterface.addColumn('submissions', 'pipeline_id', {
        type: Sequelize.STRING(32),
        allowNull: true,
        defaultValue: null
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('submissions');
    if (table.pipeline_id) await queryInterface.removeColumn('submissions', 'pipeline_id');
  }
};
