'use strict';

/**
 * Keep every processing run, instead of overwriting it.
 *
 * `submission_jobs` holds ONE row per (submission, job_type, round) — reused on
 * every re-run, which is the fix for the rival-row bug and must not change.
 * That row is therefore only ever a description of the CURRENT run: re-running
 * a step replaces its result, logs, error, timings and attribution in place.
 *
 * History goes in its own table for two reasons, both learned the hard way:
 *
 *   1. `getForSubmission` keeps "the newest row per job type". An extra row in
 *      `submission_jobs` becomes a RIVAL ROW that hides the pipeline's own —
 *      the fault that shipped a Generated KRT with 98 author rows and zero
 *      detections.
 *   2. The jobs endpoint is polled every few seconds and was deliberately
 *      changed to stop reading superseded JSONB. History rows there would undo
 *      that.
 *
 * See docs/design-run-history.md.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    // One transaction for the whole migration. The first attempt at this had
    // none: the DDL committed, the backfill failed on an enum cast, and the
    // schema was left changed while SequelizeMeta still said the migration had
    // not run — a half-applied state that is only obvious while you are
    // looking straight at it.
    await queryInterface.sequelize.transaction(async (t) => {

    // ── 1. the history table ────────────────────────────────────────────────
    const tables = await queryInterface.showAllTables({ transaction: t });
    if (!tables.includes('submission_job_runs')) {
      await queryInterface.createTable('submission_job_runs', {
        id: { type: DataTypes.UUID, defaultValue: Sequelize.literal('gen_random_uuid()'), primaryKey: true },

        submission_job_id: {
          type: DataTypes.UUID, allowNull: false,
          references: { model: 'submission_jobs', key: 'id' }, onDelete: 'CASCADE'
        },
        // Denormalised so history is queryable without a join — "everything
        // this person ran", "every run of round 1" — and so a run survives
        // being read after its job row is gone.
        submission_id: {
          type: DataTypes.UUID, allowNull: false,
          references: { model: 'submissions', key: 'id' }, onDelete: 'CASCADE'
        },
        job_type: { type: DataTypes.STRING(50), allowNull: false },
        round: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },

        /** 1-based, per (submission, job_type, round). */
        run_number: { type: DataTypes.INTEGER, allowNull: false },

        status: {
          type: DataTypes.ENUM('waiting', 'pending_input', 'queued', 'processing', 'complete', 'failed', 'cancelled'),
          allowNull: false, defaultValue: 'queued'
        },
        // The service snapshot, flattened into columns so it can be filtered on.
        // 'partial' is a real outcome: the run produced rows AND an engine
        // behind it failed.
        outcome_state: { type: DataTypes.STRING(16), allowNull: true },
        outcome_source: { type: DataTypes.STRING(16), allowNull: true },
        fail_reason: { type: DataTypes.TEXT, allowNull: true },
        external_error: { type: DataTypes.TEXT, allowNull: true },

        triggered_by_user_id: {
          type: DataTypes.UUID, allowNull: true,
          references: { model: 'users', key: 'id' }, onDelete: 'SET NULL'
        },
        /** 'manual' | 'pipeline' | 'reconciler' — computed today, never kept. */
        trigger_kind: { type: DataTypes.STRING(16), allowNull: true },

        started_at: { type: DataTypes.DATE, allowNull: true },
        completed_at: { type: DataTypes.DATE, allowNull: true },
        // Stored rather than derived: a future purge of timestamps must not
        // take the duration with it.
        duration_ms: { type: DataTypes.INTEGER, allowNull: true },
        retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

        counts: { type: DataTypes.JSONB, allowNull: true },
        // The payload. Nullable ON PURPOSE — the run RECORD (everything above)
        // is small and kept forever; the payload can be pruned later without
        // losing the history itself.
        result: { type: DataTypes.JSONB, allowNull: true },
        logs: { type: DataTypes.JSONB, allowNull: true },
        inputs: { type: DataTypes.JSONB, allowNull: true },
        /** Where this run's artefacts live; see generateJobS3Key. */
        s3_prefix: { type: DataTypes.TEXT, allowNull: true },

        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
      }, { transaction: t });
    }

    // Every one of these MUST carry the transaction. Without it the statement
    // goes out on a different connection, which cannot see a table created
    // inside this one and still uncommitted — so on a FRESH database the index
    // fails with `relation "submission_job_runs" does not exist`, the whole
    // migration rolls back, the container exits, and systemd restarts it into
    // the same failure for ever.
    //
    // It ran green everywhere the table already existed, which is every
    // database the migration had already been applied to: `CREATE TABLE IF NOT
    // EXISTS` is a no-op there and the index finds the committed table. It only
    // fails where it has never run — which is exactly a new deployment.

    // The backstop for run-number allocation. The atomic claim in
    // tryAdvanceStep already guarantees a single winner per transition; if a
    // second path ever allocates concurrently, this surfaces it as an error
    // rather than as two runs both numbered 3.
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "submission_job_runs_job_run" '
      + 'ON "submission_job_runs" ("submission_job_id", "run_number")',
      { transaction: t }
    );
    // The read the module page makes: this step's runs, newest first.
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "submission_job_runs_lookup" '
      + 'ON "submission_job_runs" ("submission_id", "round", "job_type", "run_number" DESC)',
      { transaction: t }
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "submission_job_runs_triggered_by" '
      + 'ON "submission_job_runs" ("triggered_by_user_id")',
      { transaction: t }
    );

    // ── 2. run_count on the job row ─────────────────────────────────────────
    // Denormalised so the panel and the jobs list can say "run 3" without an
    // aggregate on a table that is polled every few seconds.
    const jobs = await queryInterface.describeTable('submission_jobs', { transaction: t });
    if (!jobs.run_count) {
      await queryInterface.addColumn('submission_jobs', 'run_count', {
        type: DataTypes.INTEGER, allowNull: false, defaultValue: 1
      }, { transaction: t });
    }

    // ── 3. file provenance ──────────────────────────────────────────────────
    // "Who replaced the PDF with v2" was answerable only by correlating
    // change_logs timestamps and parsing a description.
    const files = await queryInterface.describeTable('files', { transaction: t });
    if (!files.uploaded_by_user_id) {
      await queryInterface.addColumn('files', 'uploaded_by_user_id', {
        type: DataTypes.UUID, allowNull: true,
        references: { model: 'users', key: 'id' }, onDelete: 'SET NULL'
      }, { transaction: t });
    }
    const logs = await queryInterface.describeTable('change_logs', { transaction: t });
    if (!logs.file_id) {
      await queryInterface.addColumn('change_logs', 'file_id', {
        type: DataTypes.UUID, allowNull: true,
        references: { model: 'files', key: 'id' }, onDelete: 'SET NULL'
      }, { transaction: t });
    }

    // ── 4. backfill: every existing job becomes run 1 ───────────────────────
    // So history starts COMPLETE rather than empty. `s3_prefix` points at the
    // artefacts where they already are — keyed by the job row id, which is what
    // generateJobS3Key used before runs were numbered. Files are not moved:
    // relocating hundreds of objects to satisfy a naming convention is risk
    // with no user-visible gain.
    await queryInterface.sequelize.query(`
      INSERT INTO "submission_job_runs" (
        id, submission_job_id, submission_id, job_type, round, run_number,
        status, outcome_state, outcome_source, fail_reason, external_error,
        triggered_by_user_id, trigger_kind,
        started_at, completed_at, duration_ms, retry_count,
        counts, result, logs, s3_prefix, created_at, updated_at
      )
      SELECT
        gen_random_uuid(), j.id, j.submission_id, j.job_type, j.round, 1,
        -- Via text: submission_jobs.status and submission_job_runs.status are
        -- two DISTINCT enum types with identical labels, and Postgres will not
        -- cast between them implicitly.
        j.status::text::"enum_submission_job_runs_status",
        j.result->'service'->'outcome'->>'state',
        j.result->'service'->'outcome'->>'source',
        j.result->'service'->'outcome'->>'failReason',
        j.result->'service'->'outcome'->>'externalError',
        j.triggered_by_user_id,
        NULL,
        j.started_at, j.completed_at,
        (j.result->'timing'->>'totalMs')::int,
        COALESCE(j.retry_count, 0),
        j.result->'counts', j.result, j.logs,
        'jobs/' || j.job_type || '/' || j.id,
        COALESCE(j.created_at, NOW()), NOW()
      FROM "submission_jobs" j
      WHERE NOT EXISTS (
        SELECT 1 FROM "submission_job_runs" r WHERE r.submission_job_id = j.id
      )
    `, { transaction: t });
    });
  },

  async down(queryInterface) {
    const logs = await queryInterface.describeTable('change_logs');
    if (logs.file_id) await queryInterface.removeColumn('change_logs', 'file_id');

    const files = await queryInterface.describeTable('files');
    if (files.uploaded_by_user_id) await queryInterface.removeColumn('files', 'uploaded_by_user_id');

    const jobs = await queryInterface.describeTable('submission_jobs');
    if (jobs.run_count) await queryInterface.removeColumn('submission_jobs', 'run_count');

    await queryInterface.dropTable('submission_job_runs');
    // createTable's ENUM leaves its type behind.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_submission_job_runs_status"');
  }
};
