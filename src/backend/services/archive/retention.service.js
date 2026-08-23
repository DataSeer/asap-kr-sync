/**
 * Retention: choosing what to archive, and archiving it.
 *
 * Two halves, kept apart on purpose.
 *
 *   selectSubmissions(criteria)  reads. Produces a list of submissions.
 *   archiveAndDelete(ids)        writes. Takes IDS AND NOTHING ELSE.
 *
 * ── Why the destructive half cannot take criteria ───────────────────────────
 *
 * Because a criterion is a claim about the future. `{ project: 'CS' }` means
 * "whatever matches when this runs", and what matches can change between the
 * moment someone reviews a list and the moment the delete executes — a
 * submission created in between, a status changed by someone else. Passing IDs
 * means the thing deleted is the thing that was looked at.
 *
 * It also makes the dangerous call impossible to write by accident. There is no
 * argument shape that means "everything in this project": to delete a hundred
 * submissions you must first hold a hundred ids, which is a step a person takes
 * deliberately.
 *
 * Nothing here decides WHEN. There is no sweep and no schedule: the selection
 * produces a list, a person looks at it, and the list is handed back. A cron
 * job cannot make that judgement, so it is not offered one.
 */

'use strict';

const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const archive = require('./archive.service');

/**
 * Submissions matching a set of criteria, newest first.
 *
 * Read-only, always. Every criterion is optional and they combine with AND; an
 * empty set matches everything, which is fine for a listing and is exactly why
 * the other half does not accept criteria.
 *
 * @param {object} [criteria]
 * @param {string} [criteria.project] - the two-letter grant code
 * @param {string} [criteria.userId] - the owner
 * @param {string|string[]} [criteria.status] - one or several
 * @param {Date|string} [criteria.untouchedSince] - `updatedAt` older than this
 * @param {Date|string} [criteria.createdBefore]
 * @param {number} [criteria.limit]
 * @returns {Promise<object[]>} plain rows, with what a reviewer needs to judge
 */
async function selectSubmissions(criteria = {}) {
  const { Submission, User } = require('../../models');
  const where = {};

  if (criteria.project) where.project = criteria.project;
  if (criteria.userId) where.userId = criteria.userId;
  if (criteria.status) {
    where.status = Array.isArray(criteria.status) ? { [Op.in]: criteria.status } : criteria.status;
  }
  if (criteria.untouchedSince) where.updatedAt = { [Op.lt]: new Date(criteria.untouchedSince) };
  if (criteria.createdBefore) where.createdAt = { [Op.lt]: new Date(criteria.createdBefore) };

  const rows = await Submission.findAll({
    where,
    order: [['updatedAt', 'ASC']],   // stalest first: the likeliest candidates
    ...(criteria.limit ? { limit: criteria.limit } : {}),
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'], required: false }]
  });

  return rows.map((s) => ({
    id: s.id,
    manuscriptId: s.manuscriptId,
    title: s.title,
    project: s.project,
    status: s.status,
    currentRound: s.currentRound,
    owner: s.user ? (s.user.name || s.user.email) : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  }));
}

/**
 * Archive each submission, verify the archive, then delete it.
 *
 * @param {string[]} submissionIds - explicit ids. Not criteria, ever.
 * @param {object} opts
 * @param {string} opts.outDir - a directory per submission is created under it
 * @param {string} [opts.userId] - recorded on each tombstone
 * @param {boolean} [opts.dryRun] - archive and verify, delete nothing
 * @returns {Promise<{done: object[], failed: object[]}>}
 */
async function archiveAndDelete(submissionIds, { outDir, userId = null, dryRun = false } = {}) {
  const path = require('path');
  const { Submission } = require('../../models');

  if (!Array.isArray(submissionIds) || !submissionIds.length) {
    throw new Error('Retention needs an explicit list of submission ids');
  }
  if (!outDir) throw new Error('Retention needs somewhere to write the archives');

  const unique = [...new Set(submissionIds)];
  const done = [];
  const failed = [];

  for (const id of unique) {
    // Each submission stands alone: one that cannot be archived must not stop
    // the rest, and must not be deleted either. The failure is collected and
    // reported rather than thrown, because a batch that aborts half way leaves
    // the caller guessing which half ran.
    try {
      const submission = await Submission.findByPk(id, { attributes: ['id', 'manuscriptId'] });
      if (!submission) {
        failed.push({ id, error: 'no such submission' });
        continue;
      }

      const dir = path.join(outDir, submission.manuscriptId || id);
      const manifest = await archive.exportSubmission(id, dir);

      // Read it back before deleting anything. The export just wrote it, so
      // this looks redundant — it is not: it is the only check that the bytes
      // on disk are readable and self-consistent, and it costs a fraction of
      // what it protects.
      await archive.readArchive(dir);

      if (dryRun) {
        done.push({ id, manuscriptId: submission.manuscriptId, dir, deleted: false });
        continue;
      }

      const removed = await archive.deleteSubmission(id, { archiveDir: dir, userId });
      done.push({
        id,
        manuscriptId: submission.manuscriptId,
        dir,
        deleted: true,
        rows: Object.values(removed.rows).reduce((n, v) => n + v, 0),
        objects: removed.objects,
        tables: Object.keys(manifest.tables).length
      });
    } catch (error) {
      failed.push({ id, error: error.message });
      logger.error('Retention: a submission could not be archived, and was not deleted', {
        submissionId: id, error: error.message
      });
    }
  }

  logger.info('Retention run finished', {
    asked: unique.length, done: done.length, failed: failed.length, dryRun
  });
  return { done, failed };
}

module.exports = { selectSubmissions, archiveAndDelete };
