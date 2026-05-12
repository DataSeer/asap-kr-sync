/**
 * Job Queue Service using pg-boss
 * PostgreSQL-based job queue for background processing
 */

const PgBoss = require('pg-boss');
const logger = require('../../utils/logger');

let boss = null;

/**
 * Job queue names
 */
const QUEUES = {
  PDF_ANALYSIS: 'pdf-analysis',
  DAS_EXTRACTION: 'das-extraction',
  REPORT_GENERATION: 'report-generation',
  SOFTWARE_DETECTION: 'software-detection',
  ORCID_EXTRACTION: 'orcid-extraction',
  MARKDOWN_CONVERT: 'markdown-convert',
  DATASETS_DETECTION: 'datasets-detection',
  MATERIALS_DETECTION: 'materials-detection',
  PROTOCOLS_DETECTION: 'protocols-detection',
  IDENTIFIER_DETECTION: 'identifier-detection',
  EMAIL_NOTIFICATION: 'email-notification'
};

/**
 * Compute job expiry (seconds) from the API timeout (milliseconds).
 * Formula: API timeout in seconds + 60s buffer (for S3 download, retries, overhead).
 * Minimum 120s.
 */
function getJobExpiry(apiTimeoutMs) {
  const apiSeconds = Math.ceil(apiTimeoutMs / 1000);
  return Math.max(120, apiSeconds + 60);
}

/**
 * Job configuration derived from API timeout env vars.
 * Each entry: { expireInSeconds, retryLimit, retryDelay, apiTimeoutMs }
 */
const JOB_CONFIG = {
  [QUEUES.PDF_ANALYSIS]: {
    apiTimeoutMs: parseInt(process.env.PDF_ANALYSIS_API_TIMEOUT, 10) || 300000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  [QUEUES.DAS_EXTRACTION]: {
    apiTimeoutMs: parseInt(process.env.PDF_DAS_EXTRACTOR_API_TIMEOUT, 10) || 300000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  [QUEUES.SOFTWARE_DETECTION]: {
    apiTimeoutMs: parseInt(process.env.SOFTCITE_API_TIMEOUT, 10) || 600000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  [QUEUES.REPORT_GENERATION]: {
    apiTimeoutMs: 300000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  [QUEUES.ORCID_EXTRACTION]: {
    apiTimeoutMs: parseInt(process.env.GROBID_API_TIMEOUT, 10) || 30000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 30
  },
  [QUEUES.MARKDOWN_CONVERT]: {
    apiTimeoutMs: parseInt(process.env.PDF_MARKDOWN_TIMEOUT, 10) || 120000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 30
  },
  [QUEUES.DATASETS_DETECTION]: {
    apiTimeoutMs: parseInt(process.env.DATASETS_DETECTION_API_TIMEOUT, 10) || 300000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  [QUEUES.MATERIALS_DETECTION]: {
    apiTimeoutMs: parseInt(process.env.MATERIALS_DETECTION_API_TIMEOUT, 10) || 300000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  [QUEUES.PROTOCOLS_DETECTION]: {
    apiTimeoutMs: parseInt(process.env.PROTOCOLS_DETECTION_API_TIMEOUT, 10) || 300000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 2,
    retryDelay: 60
  },
  // Identifier detection has no external API — it scans the post-conversion
  // markdown locally against the in-memory enrichment-list index. Keep a
  // short expiry so a stuck job doesn't tie up the queue.
  [QUEUES.IDENTIFIER_DETECTION]: {
    apiTimeoutMs: 60000,
    get expireInSeconds() { return getJobExpiry(this.apiTimeoutMs); },
    retryLimit: 1,
    retryDelay: 30
  }
};

/**
 * Initialize pg-boss with database connection
 * @returns {Promise<PgBoss>}
 */
async function initialize() {
  if (boss) {
    return boss;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for job queue');
  }

  boss = new PgBoss({
    connectionString: databaseUrl,
    // Schema for pg-boss tables (keeps them separate from app tables)
    schema: 'pgboss',
    // Retention settings
    archiveCompletedAfterSeconds: 60 * 60 * 24, // 24 hours
    deleteAfterDays: 7,
    // Monitoring
    monitorStateIntervalSeconds: 30,
    // Maintenance
    maintenanceIntervalSeconds: 120
  });

  // Event handlers
  boss.on('error', (error) => {
    logger.error('Job queue error:', { error: error.message });
  });

  boss.on('monitor-states', (states) => {
    logger.debug('Job queue states:', states);
  });

  // Start the boss
  await boss.start();
  logger.info('Job queue initialized (pg-boss)');

  return boss;
}

/**
 * Get the pg-boss instance
 * @returns {PgBoss}
 */
function getInstance() {
  if (!boss) {
    throw new Error('Job queue not initialized. Call initialize() first.');
  }
  return boss;
}

/**
 * Add a job to the queue
 * @param {string} queueName - Queue name from QUEUES
 * @param {object} data - Job data
 * @param {object} options - Job options
 * @returns {Promise<string>} Job ID
 */
async function addJob(queueName, data, options = {}) {
  const instance = getInstance();

  // Merge defaults from JOB_CONFIG (if available for this queue) with caller overrides
  const config = JOB_CONFIG[queueName] || {};
  const jobOptions = {
    retryLimit: options.retryLimit ?? config.retryLimit ?? 3,
    retryDelay: options.retryDelay ?? config.retryDelay ?? 60, // seconds
    expireInSeconds: options.expireIn ?? config.expireInSeconds ?? 1800,
    ...options
  };
  // Remove the shorthand 'expireIn' if present (pg-boss uses 'expireInSeconds')
  delete jobOptions.expireIn;

  const jobId = await instance.send(queueName, data, jobOptions);

  logger.info('Job added to queue', {
    queue: queueName,
    jobId,
    expireInSeconds: jobOptions.expireInSeconds,
    retryLimit: jobOptions.retryLimit,
    data: { ...data, pdf: data.pdf ? '[PDF_DATA]' : undefined }
  });

  return jobId;
}

/**
 * Register a job handler for a queue
 * @param {string} queueName - Queue name from QUEUES
 * @param {function} handler - Async function to process jobs
 * @param {object} options - Worker options
 */
async function registerHandler(queueName, handler, options = {}) {
  const instance = getInstance();

  // includeMetadata is required for `job.retrycount` to be populated on the
  // job object the handler receives. Without it pg-boss only sends
  // { id, name, data }, so retry counters always read 0 — which makes the
  // UI's "Attempt N/3" indicator stuck at 1/3 across retries.
  const workerOptions = {
    teamSize: options.concurrency || 1,
    teamConcurrency: options.teamConcurrency || 1,
    includeMetadata: true,
    ...options
  };

  await instance.work(queueName, workerOptions, async (job) => {
    logger.info('Processing job', {
      queue: queueName,
      jobId: job.id,
      retryCount: job.retrycount || 0
    });

    try {
      // Pass both job.data and the full pg-boss job object to the handler
      const result = await handler(job.data, job);
      logger.info('Job completed', { queue: queueName, jobId: job.id });
      return result;
    } catch (error) {
      logger.error('Job failed', {
        queue: queueName,
        jobId: job.id,
        retryCount: job.retrycount || 0,
        error: error.message
      });
      throw error;
    }
  });

  logger.info('Job handler registered', { queue: queueName });
}

/**
 * Get job status by ID
 * @param {string} jobId - Job ID
 * @returns {Promise<object>} Job details
 */
async function getJobStatus(jobId) {
  const instance = getInstance();
  return instance.getJobById(jobId);
}

/**
 * Cancel a job
 * @param {string} queueName - Queue name
 * @param {string} jobId - Job ID
 * @returns {Promise<boolean>}
 */
async function cancelJob(queueName, jobId) {
  const instance = getInstance();
  return instance.cancel(queueName, jobId);
}

/**
 * Get queue statistics
 * @param {string} queueName - Queue name
 * @returns {Promise<object>} Queue stats
 */
async function getQueueStats(queueName) {
  const instance = getInstance();
  return instance.getQueueSize(queueName);
}

/**
 * Gracefully stop the job queue
 * @returns {Promise<void>}
 */
async function stop() {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    logger.info('Job queue stopped');
  }
}

module.exports = {
  QUEUES,
  JOB_CONFIG,
  initialize,
  getInstance,
  addJob,
  registerHandler,
  getJobStatus,
  cancelJob,
  getQueueStats,
  stop
};
