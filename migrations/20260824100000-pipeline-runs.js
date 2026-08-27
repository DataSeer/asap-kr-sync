'use strict';

/**
 * A run becomes one coherent attempt at the whole pipeline.
 *
 * Until now a run was numbered PER STEP: software run 3, materials run 1,
 * grounding run 2. Every one of those numbers is correct on its own and the set
 * of them answers nothing — there is no name for "the attempt that produced
 * what I am looking at", and no ordering across steps except timestamps. What a
 * user reads is a mix, and the system cannot say so because it has no word for
 * the thing being mixed.
 *
 * `pipeline_runs` is that word. One row per attempt at a round; every step
 * either executed by it, or carried over from its parent by link.
 *
 * Three tables, and one rename:
 *
 *   pipeline_runs       the attempt: why it exists, what it descends from, and
 *                       the shape of the pipeline at the moment it was created
 *   step_executions     one step actually doing work — `submission_job_runs`
 *                       renamed, because "run" now means the collection
 *   pipeline_run_steps  membership. What run N contains, by reference
 *
 * ── Why membership is its own table ─────────────────────────────────────────
 *
 * Restarting one detector must not re-run the other eleven steps, so run N+1
 * legitimately contains executions run N created. The alternative — copying
 * those rows into the new run — duplicates megabytes of payload per restart and
 * creates two records of one event that can disagree. So the run POINTS at the
 * execution, and `carried_over` records that it did.
 *
 * `ON DELETE RESTRICT` on that pointer is the retention rule in the schema:
 * pruning old executions may not gut a run that still contains them.
 *
 * ── Why `step_executions.pipeline_run_id` is NOT NULL ───────────────────────
 *
 * The governing principle is that a pipeline run is a complete description of
 * one attempt, reachable without reading the submission's current state. An
 * execution belonging to no run cannot be reached that way, so it would be
 * invisible to every screen built on this model — present in the table, absent
 * from the history. A nullable column there would be a lie told by the schema.
 *
 * No backfill: existing rows are removed with the submissions they describe.
 * This is a prototype with no production data, and the standing rule for the
 * project is no backward-compatibility fallbacks.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await queryInterface.createTable('pipeline_runs', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      submission_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'submissions', key: 'id' },
        onDelete: 'CASCADE'
      },
      round: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      /** 1-based per (submission, round). Allocated inside the INSERT. */
      run_number: { type: Sequelize.INTEGER, allowNull: false },

      /**
       * Why this run exists. A string rather than an enum: the set is closed
       * today and will not stay closed — this model is meant to be lifted into
       * other projects — and a Postgres enum cannot have a value removed.
       */
      cause: { type: Sequelize.STRING(32), allowNull: false },
      caused_by_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      },
      /** What it was derived from. Null for the first run of a round. */
      parent_run_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'pipeline_runs', key: 'id' },
        onDelete: 'SET NULL'
      },

      /**
       * `superseded` is a real state, not an omission. A run replaced before it
       * finished is neither complete nor abandoned, and without the state its
       * status stays a lie for ever.
       */
      status: {
        type: Sequelize.ENUM('running', 'paused', 'complete', 'superseded'),
        allowNull: false,
        defaultValue: 'running'
      },

      /**
       * The pipeline as it stood when the run was created: the step list, each
       * step's dependencies and optional set, and each step's config state.
       *
       * Not redundant with the per-execution config. Config is written when a
       * module FINISHES, so a step that never ran has none — on a blocked round
       * today exactly 1 of 12 steps carries a config record. Without this,
       * "was software detection switched off during run 2" is unanswerable
       * precisely when it matters, and "identifier detection is absent" cannot
       * be told apart from "identifier detection did not exist yet".
       */
      shape: { type: Sequelize.JSONB, allowNull: true },

      /** Manual. Bumped when the structure changes; governs readability. */
      pipeline_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      /** Automatic. Provenance only — never read to decide compatibility. */
      app_version: { type: Sequelize.STRING(64), allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      completed_at: { type: Sequelize.DATE, allowNull: true }
    });

    await queryInterface.addIndex('pipeline_runs', ['submission_id', 'round', 'run_number'], {
      unique: true,
      name: 'pipeline_runs_submission_round_number'
    });
    await queryInterface.addIndex('pipeline_runs', ['submission_id', 'round']);
    await queryInterface.addIndex('pipeline_runs', ['parent_run_id']);

    // ── The rename ───────────────────────────────────────────────────────────
    // Rows are dropped rather than adopted: an execution with no run cannot be
    // reached from the model that replaces this one.
    await sequelize.query('DELETE FROM "submission_job_runs"');
    await queryInterface.renameTable('submission_job_runs', 'step_executions');
    // The enum type keeps the old table's name unless it is renamed too, and a
    // type called `enum_submission_job_runs_status` on a table called
    // `step_executions` is the kind of thing that costs somebody an afternoon.
    await sequelize.query(
      'ALTER TYPE "enum_submission_job_runs_status" RENAME TO "enum_step_executions_status"'
    );

    await queryInterface.addColumn('step_executions', 'pipeline_run_id', {
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: 'pipeline_runs', key: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addIndex('step_executions', ['pipeline_run_id']);

    /**
     * Every try inside this execution: `[{ n, at, ok, error, httpStatus, engine }]`.
     *
     * `retry_count: 2` with a single overwritten error cannot answer "the first
     * two attempts returned 529, then it succeeded" — which is the difference
     * between a flaky upstream and a broken one.
     */
    await queryInterface.addColumn('step_executions', 'attempts', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: []
    });

    /** The config as THIS execution saw it — may differ from the run's shape. */
    await queryInterface.addColumn('step_executions', 'config', {
      type: Sequelize.JSONB,
      allowNull: true
    });

    /**
     * `{ at, byUserId, choice }` — the decision about this execution.
     *
     * On the execution rather than the job row, which is what makes it carry
     * over with the result it is about. It also removes the field that had to
     * be cleared in three places on every re-run: a new execution was never
     * decided about, so there is nothing to forget.
     */
    await queryInterface.addColumn('step_executions', 'decision', {
      type: Sequelize.JSONB,
      allowNull: true
    });

    /** `{ missing: [jobType] }` — why this step never ran. */
    await queryInterface.addColumn('step_executions', 'skip_reason', {
      type: Sequelize.JSONB,
      allowNull: true
    });

    await queryInterface.addColumn('step_executions', 'cancelled_at', {
      type: Sequelize.DATE,
      allowNull: true
    });
    await queryInterface.addColumn('step_executions', 'cancelled_by_user_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL'
    });
    /**
     * A response that arrived after the cancel and was thrown away.
     *
     * A cancel interrupts the step and forces `cancelled`, but the external call
     * already in flight still lands. Discarding it silently means the money was
     * spent and the record says nothing; keeping it here says what came back and
     * that nothing was done with it.
     */
    await queryInterface.addColumn('step_executions', 'discarded', {
      type: Sequelize.JSONB,
      allowNull: true
    });

    // ── Membership ───────────────────────────────────────────────────────────
    await queryInterface.createTable('pipeline_run_steps', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true
      },
      pipeline_run_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'pipeline_runs', key: 'id' },
        onDelete: 'CASCADE'
      },
      job_type: { type: Sequelize.STRING(50), allowNull: false },
      /**
       * Null until the step executes. A membership row exists from the moment
       * the run is created, because "this run contains software detection, which
       * has not started" is a fact the run must be able to state.
       *
       * RESTRICT, not CASCADE: retention may prune executions, and it may not do
       * so by quietly emptying a run that still contains them.
       */
      step_execution_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'step_executions', key: 'id' },
        onDelete: 'RESTRICT'
      },
      /** True when it points at an execution another run created. */
      carried_over: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }
    });

    await queryInterface.addIndex('pipeline_run_steps', ['pipeline_run_id', 'job_type'], {
      unique: true,
      name: 'pipeline_run_steps_run_job_type'
    });
    await queryInterface.addIndex('pipeline_run_steps', ['step_execution_id']);
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;

    await queryInterface.dropTable('pipeline_run_steps');

    for (const column of [
      'discarded', 'cancelled_by_user_id', 'cancelled_at',
      'skip_reason', 'decision', 'config', 'attempts', 'pipeline_run_id'
    ]) {
      await queryInterface.removeColumn('step_executions', column);
    }

    await sequelize.query(
      'ALTER TYPE "enum_step_executions_status" RENAME TO "enum_submission_job_runs_status"'
    );
    await queryInterface.renameTable('step_executions', 'submission_job_runs');

    await queryInterface.dropTable('pipeline_runs');
    // createTable's ENUM leaves its type behind on drop.
    await sequelize.query('DROP TYPE IF EXISTS "enum_pipeline_runs_status"');
  }
};
