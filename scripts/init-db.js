#!/usr/bin/env node

/**
 * Database Initialization Script
 *
 * Creates the database and runs migrations.
 *
 * Usage:
 *   node scripts/init-db.js
 *
 * Options:
 *   --seed            Also run seeders after migrations
 *   --reset           Drop and recreate the database (WARNING: destroys all data)
 *   --preserve-users  When used with --reset, preserves user accounts
 */

const { Client } = require('pg');
const { execSync } = require('child_process');
const path = require('path');
const readline = require('readline');

// Load environment variables
const envFiles = [
  '../.env',
  '../.env.local',
  `../.env.${process.env.NODE_ENV || 'development'}`,
  `../.env.${process.env.NODE_ENV || 'development'}.local`
];

envFiles.forEach(file => {
  require('dotenv').config({ path: path.resolve(__dirname, file) });
});

// Parse DATABASE_URL
function parseDatabaseUrl(url) {
  const regex = /^postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/;
  const match = url.match(regex);

  if (!match) {
    throw new Error('Invalid DATABASE_URL format. Expected: postgresql://user:password@host:port/database');
  }

  return {
    user: match[1],
    password: match[2],
    host: match[3],
    port: parseInt(match[4], 10),
    database: match[5]
  };
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase());
    });
  });
}

/**
 * Tables to preserve during --reset --preserve-users.
 * These tables (and their migrations) will NOT be dropped.
 */
const PRESERVED_TABLES = ['users', 'user_teams', 'teams'];

/**
 * Migration files that should be marked as already run when preserving users.
 * The initial schema migration creates all tables — when preserving users,
 * we skip it (users/teams already exist) and mark it as done.
 */
const INITIAL_MIGRATION = '20250101000001-initial-schema.js';

/**
 * Drop all tables except preserved ones and clean SequelizeMeta.
 * This avoids the full DB drop/recreate cycle and keeps user accounts intact.
 */
async function resetPreservingUsers(config) {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database
  });

  try {
    await client.connect();

    // Get all user-created tables (exclude pg system tables)
    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename != 'SequelizeMeta'
    `);

    const allTables = tablesResult.rows.map(r => r.tablename);
    const tablesToDrop = allTables.filter(t =>
      !PRESERVED_TABLES.includes(t) && !t.startsWith('pgboss')
    );

    if (tablesToDrop.length === 0) {
      console.log('  No tables to drop.');
    } else {
      // Drop tables in a single CASCADE statement
      const dropList = tablesToDrop.map(t => `"${t}"`).join(', ');
      console.log(`  Dropping ${tablesToDrop.length} table(s): ${tablesToDrop.join(', ')}`);
      await client.query(`DROP TABLE IF EXISTS ${dropList} CASCADE`);
      console.log('  Tables dropped.');
    }

    // Also drop pgboss tables (they get recreated on startup)
    const pgBossTables = allTables.filter(t => t.startsWith('pgboss'));
    if (pgBossTables.length > 0) {
      const pgBossDropList = pgBossTables.map(t => `"${t}"`).join(', ');
      console.log(`  Dropping pgboss tables: ${pgBossTables.join(', ')}`);
      await client.query(`DROP TABLE IF EXISTS ${pgBossDropList} CASCADE`);
    }

    // Clear SequelizeMeta so migrations re-run
    await client.query(`DELETE FROM "SequelizeMeta"`);
    console.log('  Cleared SequelizeMeta (all migrations will re-run).');

    // Count preserved users
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    console.log(`  Preserved ${userCount.rows[0].count} user account(s).`);

  } catch (error) {
    console.error(`  Error during reset: ${error.message}`);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const shouldSeed = args.includes('--seed');
  const shouldReset = args.includes('--reset');
  const preserveUsers = args.includes('--preserve-users');

  console.log('===========================================');
  console.log('  ASAP KR-Sync - Database Initialization');
  console.log('===========================================\n');

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    console.error('Please configure it in your .env file.');
    process.exit(1);
  }

  let config;
  try {
    config = parseDatabaseUrl(databaseUrl);
  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }

  console.log(`Host:     ${config.host}:${config.port}`);
  console.log(`Database: ${config.database}`);
  console.log(`User:     ${config.user}`);
  if (preserveUsers && shouldReset) {
    console.log(`Options:  --reset --preserve-users`);
  } else if (shouldReset) {
    console.log(`Options:  --reset`);
  }
  console.log('');

  // Validate --preserve-users usage
  if (preserveUsers && !shouldReset) {
    console.log('Note: --preserve-users has no effect without --reset.\n');
  }

  if (shouldReset) {
    const warningMsg = preserveUsers
      ? 'WARNING: --reset will DELETE ALL DATA except user accounts. Continue? (yes/no): '
      : 'WARNING: --reset will DELETE ALL DATA. Continue? (yes/no): ';
    const answer = await prompt(warningMsg);
    if (answer !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  if (shouldReset && preserveUsers) {
    // Preserve users: drop all tables except users/teams, clean SequelizeMeta
    console.log('\nResetting database (preserving users)...');
    await resetPreservingUsers(config);
    console.log('');
  } else if (shouldReset) {
    // Full reset: drop and recreate the entire database
    const adminClient = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: 'postgres'
    });

    try {
      console.log('\nConnecting to PostgreSQL...');
      await adminClient.connect();
      console.log('Connected successfully.\n');

      const checkResult = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [config.database]
      );

      if (checkResult.rows.length > 0) {
        console.log(`Dropping database "${config.database}"...`);
        await adminClient.query(`
          SELECT pg_terminate_backend(pg_stat_activity.pid)
          FROM pg_stat_activity
          WHERE pg_stat_activity.datname = $1
          AND pid <> pg_backend_pid()
        `, [config.database]);
        await adminClient.query(`DROP DATABASE "${config.database}"`);
        console.log('Database dropped.\n');
      }

      console.log(`Creating database "${config.database}"...`);
      await adminClient.query(`CREATE DATABASE "${config.database}"`);
      console.log('Database created.\n');

    } catch (error) {
      console.error('ERROR:', error.message);
      if (error.code === 'ECONNREFUSED') {
        console.error('\nCannot connect to PostgreSQL. Make sure:');
        console.error('  1. PostgreSQL is running');
        console.error('  2. Host and port are correct');
      } else if (error.code === '28P01') {
        console.error('\nAuthentication failed. Check your username and password.');
      }
      process.exit(1);
    } finally {
      await adminClient.end();
    }
  } else {
    // No reset — just ensure DB exists
    const adminClient = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: 'postgres'
    });

    try {
      console.log('\nConnecting to PostgreSQL...');
      await adminClient.connect();
      console.log('Connected successfully.\n');

      const checkResult = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [config.database]
      );

      if (checkResult.rows.length === 0) {
        console.log(`Creating database "${config.database}"...`);
        await adminClient.query(`CREATE DATABASE "${config.database}"`);
        console.log('Database created.\n');
      } else {
        console.log(`Database "${config.database}" already exists.\n`);
      }
    } catch (error) {
      console.error('ERROR:', error.message);
      if (error.code === 'ECONNREFUSED') {
        console.error('\nCannot connect to PostgreSQL. Make sure:');
        console.error('  1. PostgreSQL is running');
        console.error('  2. Host and port are correct');
      } else if (error.code === '28P01') {
        console.error('\nAuthentication failed. Check your username and password.');
      }
      process.exit(1);
    } finally {
      await adminClient.end();
    }
  }

  // Run migrations
  console.log('Running migrations...');
  try {
    const backendPath = path.resolve(__dirname, '../src/backend');
    execSync('npx sequelize-cli db:migrate', {
      cwd: backendPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl }
    });
    console.log('\nMigrations completed.\n');
  } catch (error) {
    console.error('ERROR: Migrations failed.');
    process.exit(1);
  }

  // Run seeders if requested
  if (shouldSeed) {
    // When preserving users, skip the user seeder if users already exist
    if (preserveUsers && preservedUsers.length > 0) {
      console.log('Running seeders (skipping user seeder - users preserved)...');
    } else {
      console.log('Running seeders...');
    }
    try {
      const backendPath = path.resolve(__dirname, '../src/backend');
      execSync('npx sequelize-cli db:seed:all', {
        cwd: backendPath,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: databaseUrl }
      });
      console.log('\nSeeders completed.\n');
    } catch (error) {
      console.error('ERROR: Seeders failed.');
      process.exit(1);
    }
  }

  console.log('===========================================');
  console.log('  Database initialization complete!');
  console.log('===========================================\n');

  if (shouldReset) {
    console.log('IMPORTANT: If the backend is already running, restart it now.');
    console.log('           (pg-boss job queue needs to recreate its schema)\n');
  }

  console.log('Next steps:');
  console.log('  1. Start the backend:  npm run dev:backend');
  console.log('  2. Start the frontend: npm run dev:frontend');
  console.log('  Or run both:           npm run dev');
  console.log('');
}

main().catch(console.error);
