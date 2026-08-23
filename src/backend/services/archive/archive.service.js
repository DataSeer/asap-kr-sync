/**
 * A submission, out of the live instance and into a file — and back.
 *
 * The unit is the SUBMISSION, always. Not a run, not a round: everything a
 * submission owns leaves together or not at all, because a half-archived
 * submission is neither restorable nor safely deletable.
 *
 * ── Row data, not SQL ───────────────────────────────────────────────────────
 *
 * An archive is meant to be kept offline and restored later — after the schema
 * has moved. A `.sql` script restores trivially into the schema it was taken
 * from and either fails or, worse, half-succeeds into a different one, and
 * "easy to restore" is then only true at the moment you write it. This schema
 * moved seven migrations in a single day.
 *
 * So: NDJSON per table, and a restore that goes through the models. It can map
 * a renamed field, default a new one, and refuse loudly when it cannot — none
 * of which a script of INSERTs can do. It is also testable, which is the whole
 * of `archive.test.js`: an archive nobody has restored is a folder of hope.
 *
 * ── What travels, and what must already be there ────────────────────────────
 *
 * A submission owns twelve tables and points outward at exactly one thing:
 * `users`. Those rows travel too, as a manifest entry rather than as data to
 * overwrite — on restore an existing user is reused and a missing one is
 * recreated as an anonymised placeholder, so "applied by Nicolas" survives a
 * restore into an instance that never had Nicolas.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const s3Service = require('../storage/s3.service');
const { TABLES, DELETE_ORDER } = require('./archive-shape');

/**
 * Bumped when the archive LAYOUT changes — a file moved, a manifest field
 * renamed. Not when the database schema changes: that is what `appVersion` and
 * the per-table row shapes record, and a restore adapts to those.
 */
const ARCHIVE_VERSION = 1;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Read every owned row for a submission, in insert order.
 *
 * @param {string} submissionId
 * @returns {Promise<{rows: Map<string, object[]>, userIds: Set<string>}>}
 */
async function collect(submissionId) {
  const models = require('../../models');
  const rows = new Map();
  const userIds = new Set();

  const submission = await models.Submission.findByPk(submissionId);
  if (!submission) throw new Error(`No submission ${submissionId}`);
  rows.set('submissions', [submission.get({ plain: true })]);

  for (const spec of TABLES) {
    const Model = models[spec.model];
    let where;
    if (spec.via) {
      // pipeline_run_steps has no submission_id: it is reached through the runs
      // already collected, which is why the order in archive-shape matters here
      // too.
      const parents = rows.get('pipeline_runs') || [];
      where = { [spec.by]: parents.map((p) => p.id) };
      if (!parents.length) { rows.set(spec.table, []); continue; }
    } else {
      where = { [spec.by]: submissionId };
    }
    const found = await Model.findAll({ where });
    rows.set(spec.table, found.map((r) => r.get({ plain: true })));
  }

  // Every user any of it points at, so provenance survives the move.
  for (const [, list] of rows) {
    for (const row of list) {
      for (const [k, v] of Object.entries(row)) {
        if (v && /UserId$/.test(k)) userIds.add(v);
      }
      if (row.userId) userIds.add(row.userId);
    }
  }

  return { rows, userIds };
}

/**
 * Export one submission as a directory of files.
 *
 * A directory rather than a zip: zipping is one line for the caller and a
 * directory is inspectable, diffable and streamable. `scripts/archive.js` zips
 * it for handing around.
 *
 * @param {string} submissionId
 * @param {string} outDir - created if absent; must be empty or non-existent
 * @returns {Promise<object>} the manifest
 */
async function exportSubmission(submissionId, outDir) {
  const fs = require('fs/promises');
  const models = require('../../models');

  const { rows, userIds } = await collect(submissionId);
  const submission = rows.get('submissions')[0];

  await fs.mkdir(path.join(outDir, 'data'), { recursive: true });
  await fs.mkdir(path.join(outDir, 's3'), { recursive: true });

  const users = userIds.size
    ? (await models.User.findAll({ where: { id: [...userIds] } }))
      .map((u) => u.get({ plain: true }))
    : [];
  rows.set('users', users);

  // ── data ──────────────────────────────────────────────────────────────────
  const tables = {};
  // `users` first: everything else references it, and the manifest reads in
  // restore order.
  for (const table of ['users', 'submissions', ...TABLES.map((t) => t.table)]) {
    const list = rows.get(table) || [];
    // NDJSON: a 100 MB single JSON has to be parsed whole, and one row per line
    // streams and can be eyeballed.
    const body = Buffer.from(list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''));
    await fs.writeFile(path.join(outDir, 'data', `${table}.ndjson`), body);
    tables[table] = { rows: list.length, bytes: body.length, sha256: sha256(body) };
  }

  // ── s3 ────────────────────────────────────────────────────────────────────
  //
  // Walked rather than derived from the file table: job artefacts are keyed by
  // run and named by the module, and only S3 knows what is actually there.
  const prefix = submission.manuscriptId
    ? `${submission.manuscriptId}_${submission.id}`
    : submission.id;
  const objects = [];
  for (const object of await s3Service.listPrefix(prefix)) {
    const body = await s3Service.downloadFile(object.key);
    const dest = path.join(outDir, 's3', object.key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body);
    objects.push({ key: object.key, bytes: body.length, sha256: sha256(body) });
  }

  const manifest = {
    archiveVersion: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: require('../queue/pipeline-run.service').appVersion(),
    submission: {
      id: submission.id,
      manuscriptId: submission.manuscriptId,
      title: submission.title,
      currentRound: submission.currentRound
    },
    s3Prefix: prefix,
    // Counts and digests are what make a restore VERIFIABLE. Without them a
    // truncated archive restores quietly and is found out later.
    tables,
    objects
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  logger.info('Submission archived', {
    submissionId,
    outDir,
    rows: Object.values(tables).reduce((n, t) => n + t.rows, 0),
    objects: objects.length
  });
  return manifest;
}

/**
 * Read an archive back, checking it against its own manifest first.
 *
 * @param {string} dir
 * @returns {Promise<{manifest: object, data: Map<string, object[]>}>}
 */
async function readArchive(dir) {
  const fs = require('fs/promises');
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'));

  if (manifest.archiveVersion > ARCHIVE_VERSION) {
    throw new Error(
      `This archive is version ${manifest.archiveVersion}; this build understands ${ARCHIVE_VERSION}`
    );
  }

  const data = new Map();
  for (const [table, expected] of Object.entries(manifest.tables)) {
    const body = await fs.readFile(path.join(dir, 'data', `${table}.ndjson`));
    // Verified, not trusted. A truncated archive that restores quietly is the
    // failure this whole feature exists to avoid: the point of deleting a
    // submission is being sure it can come back.
    if (sha256(body) !== expected.sha256) {
      throw new Error(`${table}.ndjson does not match the manifest — the archive is damaged`);
    }
    const rows = body.toString('utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (rows.length !== expected.rows) {
      throw new Error(`${table}.ndjson holds ${rows.length} rows, the manifest says ${expected.rows}`);
    }
    data.set(table, rows);
  }
  return { manifest, data };
}

/**
 * Put a submission back.
 *
 * Refuses if it is already there. Re-keying a restore onto a fresh id was the
 * alternative and it is worse: every S3 key, every `originRowId` and every
 * cross-reference would need rewriting, and the result would be a submission
 * that looks like the archived one but is not it. "It is already here" is a
 * thing a person can act on.
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - verify and report, write nothing
 * @param {string} [opts.userId] - who restored it, for the tombstone
 * @returns {Promise<{submissionId: string, rows: object, objects: number, users: object}>}
 */
async function importSubmission(dir, { dryRun = false, userId = null } = {}) {
  const fs = require('fs/promises');
  const models = require('../../models');
  const { manifest, data } = await readArchive(dir);

  const submissionId = manifest.submission.id;
  if (await models.Submission.findByPk(submissionId)) {
    throw new Error(`Submission ${submissionId} is already here — delete it first, or restore elsewhere`);
  }
  if (dryRun) {
    return {
      submissionId,
      rows: Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.rows])),
      objects: manifest.objects.length,
      users: { reused: 0, placeholders: 0 },
      dryRun: true
    };
  }

  const users = { reused: 0, placeholders: 0 };
  const written = {};

  await models.sequelize.transaction(async (t) => {
    // ── users ───────────────────────────────────────────────────────────────
    //
    // Reused when present, recreated as a placeholder when not. NEVER
    // overwritten: an archive is a copy of a moment, and a live account that
    // has changed role or been anonymised since must not be reverted by
    // restoring an old submission.
    for (const user of data.get('users') || []) {
      if (await models.User.findByPk(user.id, { transaction: t })) { users.reused += 1; continue; }
      await models.User.create({
        ...user,
        // The archive holds a password hash. Restoring it into another instance
        // would move a credential, so the placeholder cannot be signed in to —
        // it exists to keep "who did this" answerable, nothing more.
        password: null,
        isActive: false,
        name: user.name ? `${user.name} (restored)` : 'Restored user'
      }, { transaction: t, hooks: false });
      users.placeholders += 1;
    }

    await models.Submission.create(data.get('submissions')[0], { transaction: t, hooks: false });
    written.submissions = 1;

    for (const spec of TABLES) {
      const rows = data.get(spec.table) || [];
      if (!rows.length) { written[spec.table] = 0; continue; }

      // A self-referencing table cannot be inserted in one pass: a row may name
      // a parent later in the file. Nulled first, set afterwards — the same two
      // steps the FK would otherwise force on the caller in exactly the wrong
      // order.
      const deferred = [];
      const payload = rows.map((row) => {
        if (spec.selfRef && row[spec.selfRef]) {
          deferred.push({ id: row.id, value: row[spec.selfRef] });
          return { ...row, [spec.selfRef]: null };
        }
        return row;
      });

      await models[spec.model].bulkCreate(payload, { transaction: t, hooks: false, validate: false });
      for (const { id, value } of deferred) {
        await models[spec.model].update({ [spec.selfRef]: value }, { where: { id }, transaction: t });
      }
      written[spec.table] = rows.length;
    }
  });

  // ── s3 ────────────────────────────────────────────────────────────────────
  //
  // After the transaction, deliberately. S3 has no rollback, so an upload that
  // fails half way leaves objects behind — recoverable, and far better than a
  // database transaction held open across a hundred network writes.
  let objects = 0;
  for (const object of manifest.objects) {
    const body = await fs.readFile(path.join(dir, 's3', object.key));
    if (sha256(body) !== object.sha256) {
      throw new Error(`${object.key} does not match the manifest — the archive is damaged`);
    }
    await s3Service.uploadFile(object.key, body, 'application/octet-stream');
    objects += 1;
  }

  // The tombstone is CLOSED, not deleted: "archived in March, restored in May"
  // is a truer record than a row that quietly disappears, and once the archive
  // folder is gone it is the only place that history exists.
  const [closed] = await models.SubmissionArchive.update(
    { restoredAt: new Date(), restoredByUserId: userId },
    { where: { submissionId, restoredAt: null } }
  );

  logger.info('Submission restored', { submissionId, rows: written, objects, users, closed });
  return { submissionId, rows: written, objects, users, tombstonesClosed: closed };
}

/**
 * Remove a submission and everything it owns, from the database and from S3.
 *
 * Deliberately NOT called by `importSubmission` or by anything else here: this
 * is the destructive half, and it takes an archive's manifest so it can only
 * delete something that has been archived and verified.
 *
 * @param {string} submissionId
 * @param {object} [opts]
 * @param {string} [opts.archiveDir] - verified first; deletion is refused
 *   without one, because deleting what was never archived is not retention
 * @param {string} [opts.userId] - who deleted it, for the tombstone
 * @returns {Promise<{rows: object, objects: number}>}
 */
async function deleteSubmission(submissionId, { archiveDir, userId = null } = {}) {
  const fs = require('fs/promises');
  const models = require('../../models');
  if (!archiveDir) throw new Error('Refusing to delete a submission that has not been archived');

  const { manifest } = await readArchive(archiveDir);
  if (manifest.submission.id !== submissionId) {
    throw new Error(`That archive holds ${manifest.submission.id}, not ${submissionId}`);
  }

  // The tombstone goes down BEFORE the submission comes out. If the delete then
  // fails half way the worst case is a tombstone for something still here — a
  // visible, correctable inconsistency. The other order risks a submission that
  // has vanished with nothing anywhere saying where it went, which is the state
  // this table exists to make impossible.
  const manifestBytes = await fs.readFile(path.join(archiveDir, 'manifest.json'));
  await models.SubmissionArchive.create({
    submissionId,
    manuscriptId: manifest.submission.manuscriptId,
    title: manifest.submission.title,
    archivedAt: new Date(),
    archivedByUserId: userId,
    location: path.resolve(archiveDir),
    manifestSha256: sha256(manifestBytes),
    contents: {
      tables: Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.rows])),
      objects: manifest.objects.length,
      bytes: manifest.objects.reduce((n, o) => n + o.bytes, 0)
    }
  });

  const rows = {};
  await models.sequelize.transaction(async (t) => {
    for (const table of DELETE_ORDER) {
      const spec = TABLES.find((x) => x.table === table);
      const Model = models[spec.model];
      const where = spec.via
        ? { [spec.by]: (await models.PipelineRun.findAll({
          where: { submissionId }, attributes: ['id'], transaction: t
        })).map((r) => r.id) }
        : { [spec.by]: submissionId };
      if (spec.via && !where[spec.by].length) { rows[table] = 0; continue; }
      rows[table] = await Model.destroy({ where, transaction: t });
    }
    rows.submissions = await models.Submission.destroy({ where: { id: submissionId }, transaction: t });
  });

  const objects = await s3Service.deletePrefix(manifest.s3Prefix);
  logger.info('Submission deleted after archiving', { submissionId, rows, objects, archiveDir });
  return { rows, objects };

}

module.exports = {
  exportSubmission, importSubmission, deleteSubmission, readArchive,
  ARCHIVE_VERSION, sha256, TABLES, DELETE_ORDER
};
