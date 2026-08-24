/**
 * A statement inside a transactional migration must carry the transaction.
 *
 * `queryInterface.sequelize.query(sql)` without `{ transaction: t }` goes out
 * on a DIFFERENT connection. That connection cannot see anything the migration
 * has created but not committed — so an index created that way, on a table
 * created moments earlier in the same migration, fails with
 * `relation "..." does not exist`, the whole migration rolls back, the
 * container exits, and systemd restarts it into the same failure for ever.
 *
 * What makes it dangerous is where it does NOT fail: on every database the
 * migration has already been applied to, `CREATE TABLE IF NOT EXISTS` is a
 * no-op and the index finds the committed table. It runs green on every
 * developer machine and every environment already migrated. It fails only
 * where it has never run — which is precisely a new deployment.
 *
 * Observed on the dev server: `add-run-history` crash-looped a fresh database,
 * having been green locally for three days.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'migrations');

/** The body of the `up` function, where a transaction may be open. */
function upBody(src) {
  const start = src.indexOf('async up(');
  if (start === -1) return '';
  const down = src.indexOf('async down(');
  return down === -1 ? src.slice(start) : src.slice(start, down);
}

test('every raw query inside a transactional migration carries the transaction', () => {
  const offenders = [];

  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const up = upBody(src);
    // Only migrations that actually open one can get this wrong.
    if (!up.includes('sequelize.transaction')) continue;

    for (const m of up.matchAll(/sequelize\.query\(([\s\S]*?)\);/g)) {
      if (!/transaction\s*:/.test(m[1])) {
        const line = src.slice(0, src.indexOf(m[0])).split('\n').length;
        const sql = m[1].replace(/\s+/g, ' ').trim().slice(0, 60);
        offenders.push(`${name}:${line}  ${sql}`);
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'these run on a connection that cannot see the migration\'s uncommitted '
    + 'work, so they fail on a FRESH database while passing everywhere the '
    + 'migration has already been applied'
  );
});

test('the scan can see the migrations it is meant to check', () => {
  // A wrong path would make the check pass by reading nothing.
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 5, `expected the migrations directory, found ${files.length} files`);
  assert.ok(
    files.some((f) => f.includes('add-run-history')),
    'expected the migration this test exists because of'
  );
});
