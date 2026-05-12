'use strict';

/**
 * Add `revoked_reason` to refresh_tokens.
 *
 * Distinguishes the three reasons a refresh-token row can be revoked, so
 * the auth service can react appropriately when a revoked token is replayed:
 *
 *   - 'logout'         — user-initiated logout (benign; future replays
 *                        should NOT trigger the alarming "session
 *                        compromised" chain wipe).
 *   - 'rotation'       — replaced by a successful refresh (the row's
 *                        replaced_by points to the new row). Replays of
 *                        rotation-revoked tokens DO indicate compromise
 *                        and trigger chain wipe.
 *   - 'reuse_detected' — set when a chain wipe fires; tells future
 *                        replays of any token in the chain that the chain
 *                        has already been wiped.
 *
 * Nullable: pre-existing rows have NULL reason, treated conservatively
 * (i.e. as if rotation — chain wipe still fires on replay).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      ALTER TABLE "refresh_tokens"
      ADD COLUMN IF NOT EXISTS "revoked_reason" VARCHAR(32)
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "revoked_reason"`
    );
  }
};
