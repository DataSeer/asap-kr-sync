#!/usr/bin/env node
'use strict';

/**
 * Choose submissions to archive, then archive them.
 *
 *   node scripts/retention.js --select --project CS --status completed
 *   node scripts/retention.js --select --untouched-since 2026-01-01 --ids-only > ids.txt
 *   node scripts/retention.js --archive <id> <id> … --out <dir> [--dry-run]
 *   node scripts/retention.js --archive-from ids.txt --out <dir> --confirm
 *
 * Selecting and archiving are separate invocations, and the second takes IDS —
 * never criteria. A criterion is a claim about the future: "everything in
 * project CS" means whatever matches when it runs, which is not necessarily
 * what somebody reviewed five minutes earlier. Handing over ids means the thing
 * deleted is the thing that was looked at.
 *
 * `--confirm` is required to delete more than a handful, and there is no flag
 * that means "select and delete in one go". That is deliberate: the review is
 * the feature.
 */

const fs = require('fs');
const retention = require('../src/backend/services/archive/retention.service');

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
/** Every bare value after a flag, so `--archive a b c` works. */
const listAfter = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j += 1) out.push(args[j]);
  return out;
};

/** Above this, deleting needs --confirm. */
const CONFIRM_ABOVE = 3;

async function select() {
  const rows = await retention.selectSubmissions({
    project: flag('--project'),
    userId: flag('--user'),
    status: listAfter('--status').length ? listAfter('--status') : null,
    untouchedSince: flag('--untouched-since'),
    createdBefore: flag('--created-before'),
    limit: flag('--limit') ? Number(flag('--limit')) : null
  });

  if (has('--ids-only')) {
    for (const r of rows) console.log(r.id);
    return;
  }

  if (!rows.length) { console.log('\nNothing matches.'); return; }
  console.log(`\n${rows.length} submission(s), least recently touched first:\n`);
  for (const r of rows) {
    console.log(`  ${r.manuscriptId || r.id}`);
    console.log(`    ${r.status.padEnd(12)} round ${r.currentRound}  ${r.project || '--'}  ${r.owner || 'no owner'}`);
    console.log(`    touched ${r.updatedAt.toISOString().slice(0, 10)}   ${r.id}`);
  }
  console.log('\nArchive them with:');
  console.log('  node scripts/retention.js --select … --ids-only > ids.txt');
  console.log('  node scripts/retention.js --archive-from ids.txt --out <dir> --confirm');
}

async function archive() {
  const fromFile = flag('--archive-from');
  const ids = fromFile
    ? fs.readFileSync(fromFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
    : listAfter('--archive');

  if (!ids.length) throw new Error('No submission ids given');

  const dryRun = has('--dry-run');
  if (!dryRun && ids.length > CONFIRM_ABOVE && !has('--confirm')) {
    throw new Error(
      `${ids.length} submissions is more than ${CONFIRM_ABOVE}. Re-run with --confirm, `
      + 'or with --dry-run to see what would happen.'
    );
  }

  const out = flag('--out') || 'tmp/archives';
  const { done, failed } = await retention.archiveAndDelete(ids, { outDir: out, dryRun });

  // A dry run still WRITES the archives — verifying one means reading it back
  // off disk, and a check that skipped that would be checking nothing. Only the
  // delete is withheld, and the message says so rather than letting "dry" imply
  // "nothing happened".
  console.log(dryRun
    ? `\n${done.length} archived (nothing deleted — dry run):\n`
    : `\n${done.length} archived and deleted:\n`);
  for (const d of done) {
    console.log(`  ${d.manuscriptId || d.id}`
      + (d.deleted ? `  ${d.rows} rows, ${d.objects} objects` : '  (dry run)'));
    console.log(`    ${d.dir}`);
  }
  if (failed.length) {
    // Loud, and last, so it is the thing left on screen. A batch that reports
    // only its successes is how a submission goes missing from a list nobody
    // re-reads.
    console.log(`\n${failed.length} could NOT be archived, and were NOT deleted:\n`);
    for (const f of failed) console.log(`  ${f.id}\n    ${f.error}`);
    process.exitCode = 1;
  }
}

async function main() {
  if (has('--select')) return select();
  if (has('--archive') || has('--archive-from')) return archive();

  console.log([
    'Choose submissions to archive, then archive them.',
    '',
    '  --select [--project X] [--user <id>] [--status a b] [--untouched-since YYYY-MM-DD]',
    '           [--created-before YYYY-MM-DD] [--limit N] [--ids-only]',
    '  --archive <id> [<id> …]  --out <dir> [--dry-run] [--confirm]',
    '  --archive-from <file>    --out <dir> [--dry-run] [--confirm]',
    '',
    '--dry-run still writes the archives: verifying one means reading it back.',
    '',
    'Archiving takes IDS, never criteria: the thing deleted is the thing you looked at.'
  ].join('\n'));
  process.exitCode = 1;
}

main()
  .then(() => require('../src/backend/models').sequelize.close())
  .catch(async (error) => {
    console.error(`\n${error.message}`);
    await require('../src/backend/models').sequelize.close();
    process.exit(1);
  });
