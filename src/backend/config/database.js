/**
 * Database Configuration
 *
 * Supports multiple environments with your existing PostgreSQL:
 * - development: asap_krsync_dev
 * - production: asap_krsync_prod
 * - test: asap_krsync_test
 */

const path = require('path');

// Load env files for sequelize-cli which runs outside of server.js
const envFiles = [
  '../../../.env',
  '../../../.env.local',
  `../../../.env.${process.env.NODE_ENV || 'development'}`,
  `../../../.env.${process.env.NODE_ENV || 'development'}.local`
];

envFiles.forEach(file => {
  require('dotenv').config({ path: path.resolve(__dirname, file) });
});

/**
 * Parse a PostgreSQL URL into separate fields for Sequelize CLI compatibility
 * (db:create / db:drop require individual fields, not a url property)
 */
function parseDbUrl(url) {
  const parsed = new URL(url);
  return {
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || 5432,
    dialect: 'postgres'
  };
}

// Defaults are intentionally limited to development/test only — production
// MUST set DATABASE_URL explicitly. Falling back to weak credentials in prod
// would silently mask a misconfiguration.
const defaultUrls = {
  development: 'postgresql://postgres:postgres@localhost:5432/asap_krsync_dev',
  test: 'postgresql://postgres:postgres@localhost:5432/asap_krsync_test'
};

const config = {
  development: {
    ...parseDbUrl(process.env.DATABASE_URL || defaultUrls.development),
    logging: console.log,
    pool: {
      min: parseInt(process.env.DATABASE_POOL_MIN, 10) || 2,
      max: parseInt(process.env.DATABASE_POOL_MAX, 10) || 10,
      acquire: 30000,
      idle: 10000
    }
  },
  test: {
    ...parseDbUrl(process.env.DATABASE_URL || defaultUrls.test),
    logging: false,
    pool: {
      min: 1,
      max: 5
    }
  },
  production: {
    ...parseDbUrl(process.env.DATABASE_URL),
    logging: false,
    pool: {
      min: parseInt(process.env.DATABASE_POOL_MIN, 10) || 5,
      max: parseInt(process.env.DATABASE_POOL_MAX, 10) || 20,
      acquire: 30000,
      idle: 10000
    },
    // SSL is optional - enable via DATABASE_SSL=true if needed.
    // Certificate validation is on by default; opt out only for self-signed
    // certs in trusted networks via DATABASE_SSL_REJECT_UNAUTHORIZED=false.
    ...(process.env.DATABASE_SSL === 'true' && {
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
        }
      }
    })
  }
};

module.exports = config;
