/**
 * Pipeline Reconciler
 *
 * Safety net for the background-job orchestrator. The primary advancement path
 * is workers calling orchestrator.checkAndAdvance() when a job finishes. If that
 * advancement is ever dropped (a transient DB/queue error, or the worker process
 * dying between markComplete and the advance call), the dependent jobs would sit
 * in `waiting` forever with no recovery.
 *
 * This periodic sweep re-drives any submission that has long-waiting jobs whose
 * dependencies are already terminal, so a stuck pipeline self-heals within one
 * interval. orchestrator.checkAndAdvance / tryAdvanceStep are idempotent, so the
 * sweep is safe to run alongside the live advancement path.
 */

const orchestrator = require('./orchestrator.service');
const logger = require('../../utils/logger');

const QUEUE_NAME = 'pipeline-reconciler';
const CRON_EVERY_5_MIN = '*/5 * * * *';

/**
 * Register the reconciler schedule + handler with the running pg-boss instance.
 * Safe to call once during initializeWorkers().
 *
 * @param {object} jobQueue - the job-queue.service module
 */
async function registerPipelineReconciler(jobQueue) {
  const boss = jobQueue.getInstance();
  await boss.schedule(QUEUE_NAME, CRON_EVERY_5_MIN);
  await boss.work(QUEUE_NAME, async () => orchestrator.reconcileStuckJobs());
  logger.info('Pipeline reconciler worker registered (every 5 min)');
}

module.exports = {
  registerPipelineReconciler,
  QUEUE_NAME
};
