/**
 * Refresh Token Cleanup
 *
 * Daily cron via pg-boss that purges:
 *   - rows whose refresh window expired (no longer usable for refresh)
 *   - revoked rows older than 7 days (matches refresh lifetime — by then
 *     no live token in the chain can still be valid, so the row has no
 *     forensic value)
 *
 * Without this, the refresh_tokens table grows unbounded as users rotate
 * tokens every 15 minutes.
 */

const { Op } = require('sequelize');
const { RefreshToken } = require('../../models');
const logger = require('../../utils/logger');

const QUEUE_NAME = 'refresh-token-cleanup';
const CRON_DAILY_3AM = '0 3 * * *';
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (= JWT_REFRESH_EXPIRES_IN default)

/**
 * Delete expired and old-revoked refresh tokens.
 * @returns {Promise<number>} number of rows deleted
 */
async function cleanup() {
  const now = new Date();
  const cutoff = new Date(Date.now() - REVOKED_RETENTION_MS);

  const deleted = await RefreshToken.destroy({
    where: {
      [Op.or]: [
        { expiresAt: { [Op.lt]: now } },
        { revokedAt: { [Op.lt]: cutoff } }
      ]
    }
  });

  if (deleted > 0) {
    logger.info('Refresh token cleanup', { deleted });
  }
  return deleted;
}

/**
 * Register the cleanup job + handler with the running pg-boss instance.
 * Safe to call once during initializeWorkers().
 *
 * @param {object} jobQueue - the job-queue.service module
 */
async function registerRefreshTokenCleanup(jobQueue) {
  const boss = jobQueue.getInstance();
  await boss.schedule(QUEUE_NAME, CRON_DAILY_3AM);
  await boss.work(QUEUE_NAME, async () => cleanup());
  logger.info('Refresh token cleanup worker registered (daily 03:00 UTC)');
}

module.exports = {
  cleanup,
  registerRefreshTokenCleanup,
  QUEUE_NAME
};
