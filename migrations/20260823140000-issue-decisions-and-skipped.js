'use strict';

/**
 * Every pipeline issue is decided, and a step can be skipped.
 *
 * Two changes that belong together, because they are the two halves of one
 * rule: a step that did not finish cleanly holds what comes after it until a
 * person decides, and if the missing data was *required* the decision cannot be
 * "run them anyway" — it has to be "skip them".
 *
 * ── The rename ──────────────────────────────────────────────────────────────
 *
 * `failure_acknowledged_*` was named when only a `failed` step could hold the
 * pipeline. A PARTIAL now holds it too — the module produced a real result with
 * one of its engines dead — and so does a step that completed while producing
 * nothing usable. "Failure" is no longer the word for what is being decided
 * about, so the columns say `issue_` instead.
 *
 * ── The status ──────────────────────────────────────────────────────────────
 *
 * `skipped` is what a step becomes when something it REQUIRED produced nothing
 * and the user chose to carry on. The three alternatives are all worse:
 *
 *   - run it anyway → it fails, and so does everything after it: nine
 *     unexplained failures where there was one real one;
 *   - leave it `waiting` → `allProcessesFinished` never becomes true, which
 *     blocks the submission's own Continue button. The user is then trapped in
 *     the step with no way out;
 *   - mark it `cancelled` → that word means "a person stopped this", and a
 *     report needs to tell "skipped because the conversion produced no text"
 *     apart from "cancelled deliberately".
 *
 * Added to BOTH enums. A skipped step never runs, so it should never open a run
 * record — but `closeRun` copies the job's status onto the run, and an enum
 * missing a value its sibling has is a landmine for whoever reaches that path.
 *
 * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, which is why
 * this migration deliberately does not open one.
 */

module.exports = {
  async up(queryInterface) {
    const table = await queryInterface.describeTable('submission_jobs');

    if (table.failure_acknowledged_at && !table.issue_acknowledged_at) {
      await queryInterface.renameColumn('submission_jobs', 'failure_acknowledged_at', 'issue_acknowledged_at');
    }
    if (table.failure_acknowledged_by_user_id && !table.issue_acknowledged_by_user_id) {
      await queryInterface.renameColumn(
        'submission_jobs', 'failure_acknowledged_by_user_id', 'issue_acknowledged_by_user_id'
      );
    }

    // IF NOT EXISTS so a re-run is a no-op: an enum value cannot be dropped, so
    // this migration's `down` leaves it in place and `up` must tolerate it.
    for (const enumName of ['enum_submission_jobs_status', 'enum_submission_job_runs_status']) {
      await queryInterface.sequelize.query(
        `ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS 'skipped'`
      );
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('submission_jobs');

    if (table.issue_acknowledged_at) {
      await queryInterface.renameColumn('submission_jobs', 'issue_acknowledged_at', 'failure_acknowledged_at');
    }
    if (table.issue_acknowledged_by_user_id) {
      await queryInterface.renameColumn(
        'submission_jobs', 'issue_acknowledged_by_user_id', 'failure_acknowledged_by_user_id'
      );
    }

    // The enum value stays. Postgres cannot drop one, and rebuilding both types
    // to remove a label nothing references would risk far more than it removes.
  }
};
