#!/usr/bin/env node
/**
 * Dump everything, raw: the database into one folder, S3 into another.
 *
 * For keeping a copy of submissions before they are removed, so they can still
 * be processed by hand or by another tool later. It is **not** a backup you can
 * restore from: no ordering, no foreign-key handling, no import path. Just the
 * rows as JSON and the stored objects as they are.
 *
 * Strictly READ-ONLY. It never deletes and never writes to the database or S3.
 *
 *   <out>/database/<table>.json     every row of every table
 *   <out>/s3/<key…>                 every stored object, path mirroring its key
 *   <out>/DUMP.json                 what was written, and when
 *
 * EVERY row means every row: `users` carries bcrypt password hashes and
 * `refresh_tokens` carries live session tokens. A dump is therefore as
 * sensitive as the database it came from — anyone holding it holds every
 * session. It is written 0700/0600 and the script says so on the way out;
 * keep it off shared storage and delete it when the archive is no longer
 * needed.
 *
 * Usage:
 *   node scripts/dump-data.js --out DIR
 *   node scripts/dump-data.js --out DIR --dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Tables whose contents are credentials, called out in the summary. */
const SENSITIVE_TABLES = ['users', 'refresh_tokens'];

/** Owner-only, for a file nobody else has any business reading. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { sequelize } = require('../src/backend/models');
const { QueryTypes } = require('sequelize');
const {
  S3Client, ListObjectsV2Command, GetObjectCommand
} = require('@aws-sdk/client-s3');

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const OUT = outIndex >= 0 ? args[outIndex + 1] : null;
const DRY_RUN = args.includes('--dry-run');

if (!OUT || args.includes('--help')) {
  console.log('Usage: node scripts/dump-data.js --out DIR [--dry-run]');
  process.exit(OUT ? 0 : 1);
}

/**
 * Every table in the public schema, in a stable order.
 *
 * `table_name::text AS name` is not decoration. `information_schema` columns are
 * of Postgres's `name` type, and this driver hands those rows back as ARRAYS
 * rather than objects — `row.table_name` is undefined and the next statement
 * asks for a relation literally called "undefined". Casting to text gives an
 * ordinary object. (Selects against the app's own tables are unaffected, which
 * is why the dump itself keeps its column names.)
 */
async function tables() {
  const rows = await sequelize.query(`
    SELECT table_name::text AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `, { type: QueryTypes.SELECT });
  return rows.map((r) => r.name);
}

async function dumpDatabase() {
  const dir = path.join(OUT, 'database');
  if (!DRY_RUN) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // mkdir's mode is masked by the process umask, and the directory may
    // already exist from an earlier run. chmod is not.
    fs.chmodSync(OUT, DIR_MODE);
    fs.chmodSync(dir, DIR_MODE);
  }

  const counts = {};
  for (const table of await tables()) {
    const rows = await sequelize.query(`SELECT * FROM "${table}"`, { type: QueryTypes.SELECT });
    counts[table] = rows.length;
    if (!DRY_RUN) {
      const file = path.join(dir, `${table}.json`);
      fs.writeFileSync(file, JSON.stringify(rows, null, 2), { mode: FILE_MODE });
      fs.chmodSync(file, FILE_MODE);
    }
    const note = SENSITIVE_TABLES.includes(table) ? '  ← credentials' : '';
    console.log(`  ${table.padEnd(28)} ${rows.length} row(s)${note}`);
  }
  return counts;
}

/** A filesystem path mirroring the S3 key, minus anything awkward. */
const safePath = (key) => key.split('/').map((p) => p.replace(/[^\w.@-]+/g, '_')).join(path.sep);

async function dumpS3() {
  const bucket = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;
  const prefix = process.env.S3_BUCKET_PREFIX || '';
  if (!bucket) {
    console.log('  (no S3 bucket configured — skipped)');
    return { objects: 0, bytes: 0 };
  }

  const client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(process.env.AWS_ACCESS_KEY_ID ? {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    } : {})
  });

  const dir = path.join(OUT, 's3');
  if (!DRY_RUN) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
  }

  let token;
  let objects = 0;
  let bytes = 0;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token
    }));
    for (const obj of listed.Contents || []) {
      objects++;
      bytes += obj.Size || 0;
      if (DRY_RUN) continue;

      const dest = path.join(dir, safePath(obj.Key));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        fs.writeFileSync(dest, Buffer.concat(chunks), { mode: FILE_MODE });
      } catch (error) {
        // Reported and skipped: a dump that stops halfway is worse than one
        // that says which object it could not read.
        console.warn(`  ! ${obj.Key}: ${error.message}`);
      }
      if (objects % 50 === 0) console.log(`  … ${objects} object(s)`);
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);

  console.log(`  ${objects} object(s), ${(bytes / 1048576).toFixed(1)} MB`);
  return { objects, bytes };
}

(async () => {
  console.log(`Dumping to ${OUT}${DRY_RUN ? ' (DRY RUN — nothing written)' : ''}\n`);

  console.log('Database:');
  const counts = await dumpDatabase();

  console.log('\nS3:');
  const s3 = await dumpS3();

  if (!DRY_RUN) {
    fs.writeFileSync(path.join(OUT, 'DUMP.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      note: 'Raw dump. Rows as stored, plus the S3 objects. Not a restorable backup.',
      warning: 'Contains bcrypt password hashes (users) and live session tokens '
        + '(refresh_tokens). Treat this folder as you would the database itself.',
      database: counts,
      s3
    }, null, 2), { mode: FILE_MODE });
  }

  const dumped = SENSITIVE_TABLES.filter((t) => counts[t] > 0);
  if (dumped.length && !DRY_RUN) {
    console.log(`\n  !  ${dumped.join(' and ')} are in this dump: password hashes and live`);
    console.log('     session tokens. Written 0700/0600 — keep it off shared storage.');
  }

  console.log('\nDone. Nothing was deleted.');
  await sequelize.close();
})().catch(async (error) => {
  console.error('Fatal:', error.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
