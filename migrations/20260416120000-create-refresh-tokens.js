'use strict';

/**
 * Create refresh_tokens table
 *
 * Backs the server-side refresh token rotation + revocation flow:
 * - Each issued refresh token gets a row keyed by sha256(token).
 * - Successful refresh marks the row revoked and inserts a new row, linked
 *   via replaced_by (the rotation chain). Reuse of a revoked token signals
 *   compromise and triggers chain-wide revocation.
 * - Logout marks the user's current row revoked.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      CREATE TABLE IF NOT EXISTS "refresh_tokens" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "token_hash" CHAR(64) NOT NULL UNIQUE,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "revoked_at" TIMESTAMPTZ,
        "replaced_by" UUID REFERENCES "refresh_tokens"("id") ON DELETE SET NULL,
        "user_agent" VARCHAR(500),
        "ip" VARCHAR(45),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await q(`CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_expires_at_idx" ON "refresh_tokens" ("user_id", "expires_at")`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "refresh_tokens" CASCADE`);
  }
};
