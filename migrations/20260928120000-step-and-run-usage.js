'use strict';

/**
 * What each execution spent, kept where it survives.
 *
 * The per-job tally already reaches `submission_jobs.result.tokens` and is
 * copied into `step_executions.result`. Neither is a place a figure can live:
 * the job row is replaced by the next run of that step, and `result` is
 * documented as prunable — "the record above is small and kept forever; this
 * can be pruned without losing the history". A token count inside a prunable
 * blob is a token count with an expiry date, and the one question it exists to
 * answer ("what has this document cost us so far") is asked about the past.
 *
 * So `usage` is its own column, next to `discarded` and `counts`, in the part
 * of the row that is kept: small, flat, and readable without the payload.
 *
 * Two levels, because they answer two questions:
 *
 *   - `step_executions.usage` — one execution of one module, including the
 *     tokens of any response that arrived after a cancel (`discarded`). The
 *     fact, recorded where the fact happened.
 *   - `pipeline_runs.usage` — the same summed over that run's steps, so the
 *     pipeline page does not walk every step's JSON on every read. It is a
 *     derived value and is always RECOMPUTED from the steps, never incremented:
 *     modules complete concurrently (workers run at `concurrency: 2`), and an
 *     increment that lost a race would leave a figure that is wrong, plausible
 *     and permanent. A recompute that loses a race writes the same total twice.
 *
 * Nullable, no backfill. NULL means "nothing recorded this" — either a row that
 * predates the column, or an execution that called no model at all. Writing a
 * zero would assert that a module spent nothing, which is a different claim and
 * one nothing witnessed.
 *
 * Deliberately no price, no currency, and no rate anywhere in this schema. What
 * a token costs is not a property of a pipeline run, it changes without the run
 * changing, and it is not this repository's business.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const steps = await queryInterface.describeTable('step_executions');
    if (!steps.usage) {
      await queryInterface.addColumn('step_executions', 'usage', {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null
      });
    }

    const runs = await queryInterface.describeTable('pipeline_runs');
    if (!runs.usage) {
      await queryInterface.addColumn('pipeline_runs', 'usage', {
        type: Sequelize.JSONB,
        allowNull: true,
        defaultValue: null
      });
    }
  },

  async down(queryInterface) {
    const runs = await queryInterface.describeTable('pipeline_runs');
    if (runs.usage) await queryInterface.removeColumn('pipeline_runs', 'usage');

    const steps = await queryInterface.describeTable('step_executions');
    if (steps.usage) await queryInterface.removeColumn('step_executions', 'usage');
  }
};
