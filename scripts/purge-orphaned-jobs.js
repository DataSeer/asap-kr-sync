#!/usr/bin/env node

/**
 * Purge orphaned pg-boss queue entries.
 *
 * When a submission is deleted, `submission_jobs.submission_id` is
 * ON DELETE CASCADE so its job rows go with it — but pg-boss keeps its own
 * table with no foreign key to ours, so the QUEUE ENTRIES survive. A worker
 * then picks one up, looks up a submission that no longer exists, and logs
 * "Submission not found", once per retry. No LM call is made (the lookup fails
 * before that), but the noise is endless.
 *
 * The app now cancels queued work when a submission is deleted, and treats a
 * missing submission as terminal instead of retrying it. This script clears the
 * entries that accumulated BEFORE those fixes.
 *
 * The same thing is available in the UI: /admin/jobs → "Orphaned queue".
 *
 * SAFETY: dry-run by default. Nothing is modified without --apply.
 *
 * Usage:
 *   node scripts/purge-orphaned-jobs.js            # report only (default)
 *   node scripts/purge-orphaned-jobs.js --apply    # cancel them
 *
 * Environment:
 *   DATABASE_URL — read from .env, or the surrounding environment.
 *
 * Inside the app container (Postgres is NOT containerised by default; the app
 * reaches it at host.docker.internal):
 *   docker compose exec app node scripts/purge-orphaned-jobs.js
 *   docker compose exec app node scripts/purge-orphaned-jobs.js --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const APPLY = process.argv.includes('--apply');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

if (HELP) {
  console.log(require('fs').readFileSync(__filename, 'utf-8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

/**
 * `.env` holds the URL the APP CONTAINER uses, which points at
 * `host.docker.internal` — a name that resolves inside Docker and nowhere else.
 * Running this script on the host with that URL fails with ENOTFOUND, which
 * reads like a database outage and is not one.
 *
 * If the name does not resolve, we are on the host: rewrite it to loopback.
 * Compose publishes Postgres on 127.0.0.1:5432, so it is the same server.
 * Credentials are left untouched — only the host part changes.
 */
async function applyHostFallback() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('host.docker.internal')) return;

  const dns = require('dns').promises;
  try {
    await dns.lookup('host.docker.internal');
    return; // resolves — we are inside the container, use it as-is
  } catch {
    process.env.DATABASE_URL = url.replace('host.docker.internal', '127.0.0.1');
    console.log('Note: host.docker.internal does not resolve here, so this is running on the host.');
    console.log('      Connecting to 127.0.0.1 instead (same server, published by compose).\n');
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Run from the project root (so .env is found), or export it.');
    process.exit(1);
  }

  await applyHostFallback();

  const {
    findOrphanedQueueEntries,
    purgeOrphanedQueueEntries
  } = require('../src/backend/services/queue/job-admin.service');
  const { sequelize } = require('../src/backend/models');

  try {
    const entries = await findOrphanedQueueEntries();

    if (entries.length === 0) {
      console.log('No orphaned queue entries. Nothing to do.');
      return;
    }

    // Summarise by queue so the operator sees the shape before acting.
    const byQueue = entries.reduce((acc, e) => {
      acc[e.name] = (acc[e.name] || 0) + 1;
      return acc;
    }, {});

    console.log(`\nFound ${entries.length} orphaned queue entr${entries.length === 1 ? 'y' : 'ies'}:\n`);
    for (const [queue, count] of Object.entries(byQueue).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${queue}`);
    }

    const oldest = entries[0];
    console.log(`\n  oldest: ${oldest.createdOn} (submission ${oldest.submissionId || 'unknown'})`);

    if (!APPLY) {
      console.log('\nDRY RUN — nothing was modified.');
      console.log('Re-run with --apply to cancel these entries.\n');
      return;
    }

    const { cancelled } = await purgeOrphanedQueueEntries();
    console.log(`\nCancelled ${cancelled} queue entr${cancelled === 1 ? 'y' : 'ies'}.`);
    console.log('They move to pg-boss\'s terminal `cancelled` state; its own maintenance clears them later.\n');
  } finally {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
