#!/usr/bin/env node
'use strict';

/**
 * Archive a submission to a folder, restore one, or delete an archived one.
 *
 *   node scripts/archive-submission.js --export <submissionId> --out <dir>
 *   node scripts/archive-submission.js --import <dir> [--dry-run]
 *   node scripts/archive-submission.js --delete <submissionId> --archive <dir>
 *
 * The three are separate commands on purpose. Deleting takes an archive
 * directory and verifies it before touching anything, so a submission can only
 * be removed once a copy of it has been read back and checked — "archive then
 * delete" as one command would make that check something a flag could skip.
 */

const path = require('path');
const archive = require('../src/backend/services/archive/archive.service');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(name);

async function main() {
  const exportId = flag('--export');
  const importDir = flag('--import');
  const deleteId = flag('--delete');

  if (exportId) {
    const out = flag('--out') || path.join('tmp', 'archives', exportId);
    const manifest = await archive.exportSubmission(exportId, out);
    const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
    console.log(`\nArchived ${manifest.submission.manuscriptId || manifest.submission.id}`);
    console.log(`  ${rows} rows across ${Object.keys(manifest.tables).length} tables`);
    console.log(`  ${manifest.objects.length} S3 objects`);
    console.log(`  -> ${out}`);
    console.log('\nRestore it with:');
    console.log(`  node scripts/archive-submission.js --import ${out}`);
    return;
  }

  if (importDir) {
    const result = await archive.importSubmission(importDir, { dryRun: has('--dry-run') });
    const total = Object.values(result.rows).reduce((n, v) => n + v, 0);
    console.log(result.dryRun
      ? `\nWould restore ${result.submissionId}: ${total} rows, ${result.objects} objects`
      : `\nRestored ${result.submissionId}`);
    if (!result.dryRun) {
      console.log(`  ${total} rows, ${result.objects} objects`);
      console.log(`  users: ${result.users.reused} reused, ${result.users.placeholders} recreated`);
    }
    return;
  }

  if (deleteId) {
    const dir = flag('--archive');
    if (!dir) throw new Error('--delete needs --archive <dir>: nothing is deleted unarchived');
    const result = await archive.deleteSubmission(deleteId, { archiveDir: dir });
    const total = Object.values(result.rows).reduce((n, v) => n + v, 0);
    console.log(`\nDeleted ${deleteId}: ${total} rows, ${result.objects} objects`);
    console.log('  a tombstone was recorded — the submission is gone, not forgotten');
    console.log(`  restore it with: node scripts/archive-submission.js --import ${dir}`);
    return;
  }

  if (has('--list')) {
    const { SubmissionArchive } = require('../src/backend/models');
    const rows = await SubmissionArchive.listMissing();
    if (!rows.length) { console.log('\nNothing archived and still away.'); return; }
    console.log(`\n${rows.length} archived submission(s) not currently here:\n`);
    for (const r of rows) {
      const n = Object.values(r.contents?.tables || {}).reduce((a, b) => a + b, 0);
      console.log(`  ${r.manuscriptId || r.submissionId}`);
      console.log(`    ${r.archivedAt.toISOString().slice(0, 10)} · ${n} rows, `
        + `${r.contents?.objects || 0} objects · ${r.manifestSha256.slice(0, 12)}`);
      console.log(`    ${r.location}`);
    }
    return;
  }

  console.log([
    'Archive a submission to a folder, restore one, or delete an archived one.',
    '',
    '  --export <submissionId> --out <dir>',
    '  --import <dir> [--dry-run]',
    '  --delete <submissionId> --archive <dir>',
    '  --list                              what has been archived and not restored',
    '',
    'Deleting verifies the archive first: nothing is removed unarchived.'
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
