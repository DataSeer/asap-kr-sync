/**
 * ASAP KR-Sync - Server Entry Point
 */

const path = require('path');
const { loadAuth0Secret } = require('./config/auth0-secret-loader');

// Load environment-specific config
// Priority: .env.{NODE_ENV}.local > .env.{NODE_ENV} > .env.local > .env
const envFiles = [
  '../../.env',
  '../../.env.local',
  `../../.env.${process.env.NODE_ENV || 'development'}`,
  `../../.env.${process.env.NODE_ENV || 'development'}.local`
];

envFiles.forEach(file => {
  require('dotenv').config({ path: path.resolve(__dirname, file) });
});

// Fill in each Gemini module's key and model from the shared GEMINI_API_KEY /
// GEMINI_MODEL, unless that module names its own. This runs HERE -- after the
// .env files, before the first config is required -- because config modules
// read process.env at require time, and because a child process inherits
// environment variables rather than the expression that produced them. The
// LangExtract script that datasets detection spawns reads its per-module
// variable directly; before this call it found nothing and exited 1 while
// every Node-side status check reported the module configured.
const { applyGeminiDefaults, geminiKeySources } = require('./config/gemini');

// Snapshot BEFORE filling. Afterwards every module reports a key of its own,
// because the pass has just given it one -- so "who configured their own key"
// is a question only answerable from this side of the call.
const geminiBefore = geminiKeySources();
applyGeminiDefaults();

/**
 * Validate required environment variables. Note that Auth0 vars are NOT
 * checked here — they are gated by the AUTH0_ENABLED feature flag inside
 * auth0.service.js. DATABASE_URL and JWT_SECRET are still loaded from .env
 * (Secrets Manager only manages Auth0 credentials).
 */
function assertEnvVars() {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    if (process.env.JWT_SECRET.length < 32) {
      console.error('FATAL: JWT_SECRET must be at least 32 characters in production');
      process.exit(1);
    }
    if (!process.env.FRONTEND_URL || !/^https:\/\//.test(process.env.FRONTEND_URL)) {
      console.error('FATAL: FRONTEND_URL must be set to an https URL in production');
      process.exit(1);
    }
  }
}

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // 1. Load Auth0 credentials from AWS Secrets Manager when AUTH0_SECRET_ID
    //    is set (production / staging on EC2). Otherwise no-op (caller relies
    //    on .env values for local dev).
    await loadAuth0Secret();

    //    ...then resolve the Gemini keys again. The secret loader Object.assigns
    //    arbitrary JSON into process.env, so a GEMINI_API_KEY arriving from
    //    Secrets Manager lands AFTER the pass at the top of this file. Running
    //    it twice is free -- it fills only what is missing -- and skipping it
    //    would leave the per-module names unset for the one deployment that
    //    keeps its credentials where they belong.
    applyGeminiDefaults();

    // 2. Validate baseline env (DATABASE_URL, JWT_SECRET, FRONTEND_URL).
    assertEnvVars();

    // 3. Now safe to require modules that consume env vars at import time.
    //    auth0.service.js reads AUTH0_* at module top, jwt.service.js reads
    //    JWT_SECRET at module top, database.js reads DATABASE_URL.
    const app = require('./app');
    const { sequelize } = require('./models');
    const jobQueue = require('./services/queue/job-queue.service');
    const { initializeWorkers } = require('./services/queue/workers');
    const configService = require('./services/config.service');
    const logger = require('./utils/logger');

    // Say which modules have a key and where it came from. This is the line
    // that would have turned "datasets detection is on but produces nothing"
    // into a one-glance answer, so it is worth the four fields.
    const gemini = geminiKeySources();
    logger.info('Gemini credentials resolved', {
      withKey: gemini.filter((m) => m.hasKey).length,
      total: gemini.length,
      ownKey: geminiBefore.filter((m) => m.own).map((m) => m.module),
      inherited: geminiBefore.filter((m) => !m.own).length,
      missing: gemini.filter((m) => !m.hasKey).map((m) => m.module)
    });

    // Test database connection
    await sequelize.authenticate();
    logger.info('Database connection established successfully');

    // Initialize config service (loads config from DB into cache)
    await configService.initialize();
    logger.info('Config service initialized');

    // Initialize job queue (pg-boss)
    await jobQueue.initialize();
    logger.info('Job queue initialized');

    // Register job workers
    await initializeWorkers();
    logger.info('Job workers registered');

    // Start HTTP server
    const server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await jobQueue.stop();
          logger.info('Job queue stopped');

          await sequelize.close();
          logger.info('Database connection closed');
          process.exit(0);
        } catch (err) {
          logger.error('Error during shutdown:', err);
          process.exit(1);
        }
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    console.error('Unable to start server:', error);
    process.exit(1);
  }
}

startServer();
