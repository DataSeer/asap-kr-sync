'use strict';

/**
 * Add a 'cancelled' value to the submission_jobs.status enum.
 *
 * Backs the user-facing "Cancel processing" switch: jobs that had not started
 * (waiting / pending_input / queued) are marked 'cancelled' — a real terminal
 * status, distinct from 'failed'. The presence of any 'cancelled' job in a
 * (submission, round) is also the signal the pipeline reads to stop advancing
 * and to skip retries on the module that was still running.
 *
 * Postgres note: ALTER TYPE ... ADD VALUE cannot run inside a transaction on
 * older servers, so this migration issues the statement directly (sequelize-cli
 * does not wrap it in one here). It is idempotent via IF NOT EXISTS.
 *
 * Down is intentionally a no-op: Postgres cannot drop a single enum value
 * without recreating the type, which would require rewriting the column and any
 * rows using it. Leaving the value in place is harmless.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "public"."enum_submission_jobs_status" ADD VALUE IF NOT EXISTS 'cancelled'`
    );
  },

  async down() {
    // No-op — see the note above. Removing an enum value in Postgres is not a
    // simple reversible operation and the extra value is inert if unused.
  }
};
