/**
 * What this round is being processed from.
 *
 * Every step used to resolve its own input: nine services running the same
 * `File.findOne({ type }, order: version DESC)`, each answering "the latest
 * one" at whatever moment it happened to run. There was no pipeline-level
 * notion of the round's inputs, so replacing a file mid-run split the round —
 * some steps had read the old version, some the new, and nothing said so.
 *
 * The KRT was worse, because nothing restarts when it changes. Detectors are
 * seeded from `krt_data` when each one runs; PDF Analysis reads `krt_data`
 * again when it consolidates. An author editing their table between the two —
 * which the workflow invites, the editor being one click away — got an analysis
 * whose detections came from one table and whose consolidation reconciled
 * against another.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The FIRST step in a round to read an input freezes it. Every later reader in
 * that round is handed the same thing.
 *
 * The freeze levels are not configured; they fall out of the dependency graph.
 * The PDF is frozen by Markdown Convert, which starts the round. The KRT is
 * frozen by the first detector, and the detectors are gated on `krt_curated` —
 * so the KRT freezes after the author has validated it, which is where it
 * belongs. Adding a step changes the levels correctly and automatically,
 * because the levels ARE the graph.
 *
 * ── Not fail-soft ───────────────────────────────────────────────────────────
 *
 * Most of this codebase degrades rather than stops, and that is usually right.
 * Not here. A freeze that fails silently means the step reads *something* — and
 * the whole purpose of this file is that nobody can tell which something. A
 * step that cannot establish its input fails, visibly, and is retried.
 */

'use strict';

const { Op } = require('sequelize');
const { SubmissionInputFreeze, File, KRTData, sequelize } = require('../../models');
const { INPUT_KINDS } = require('../../models/SubmissionInputFreeze');
const { FILE_TYPES } = require('../../config/constants');
const logger = require('../../utils/logger');

/** The File type behind each file-shaped input kind. */
const FILE_TYPE_FOR_KIND = {
  [INPUT_KINDS.PDF]: FILE_TYPES.PDF,
  [INPUT_KINDS.MARKDOWN]: FILE_TYPES.MARKDOWN
};

/**
 * Read a freeze row, if this round has one.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} inputKind
 * @returns {Promise<SubmissionInputFreeze|null>}
 */
async function find(submissionId, round, inputKind) {
  return SubmissionInputFreeze.findOne({ where: { submissionId, round, inputKind } });
}

/**
 * Create the freeze, tolerating a concurrent creator.
 *
 * Detectors start within milliseconds of each other: two of them find no freeze
 * and both try to create one. The unique constraint decides, and the loser
 * re-reads the winner's row rather than failing — the point is that the round
 * agrees on one answer, not that a particular step wins the race.
 *
 * @returns {Promise<SubmissionInputFreeze>}
 */
async function createOrRead(attrs) {
  const { submissionId, round, inputKind } = attrs;
  try {
    return await SubmissionInputFreeze.create(attrs);
  } catch (err) {
    if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
    const existing = await find(submissionId, round, inputKind);
    if (!existing) throw err;   // a different constraint; do not swallow it
    logger.debug('Input freeze: lost the race, using the round\'s existing freeze', {
      submissionId, round, inputKind, frozenBy: existing.frozenByJobType
    });
    return existing;
  }
}

/**
 * The file this round reads for `inputKind`, freezing it on first read.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string} inputKind - INPUT_KINDS.PDF or INPUT_KINDS.MARKDOWN
 * @param {object} [options]
 * @param {string} [options.jobType] - the step asking, recorded on a new freeze
 * @returns {Promise<File|null>} null when the round has no such file yet
 */
async function resolveFile(submissionId, round, inputKind, { jobType = null } = {}) {
  const fileType = FILE_TYPE_FOR_KIND[inputKind];
  if (!fileType) throw new Error(`resolveFile: ${inputKind} is not a file input`);

  const frozen = await find(submissionId, round, inputKind);
  if (frozen?.fileId) {
    const file = await File.findByPk(frozen.fileId);
    if (file) return file;

    // The frozen file is gone. Reading the latest instead would silently answer
    // a different question, which is the failure this whole file exists to
    // prevent — so say what happened and stop.
    throw new Error(
      `The ${inputKind} this round was processing (version ${frozen.fileVersion}) no longer exists. ` +
      'Start a new round, or restart the pipeline to pick up the current file.'
    );
  }

  const latest = await File.findOne({
    where: { submissionId, type: fileType, round },
    order: [['version', 'DESC']]
  });
  if (!latest) return null;

  await createOrRead({
    submissionId,
    round,
    inputKind,
    fileId: latest.id,
    fileVersion: latest.version,
    s3Key: latest.s3Key,
    bytes: latest.size ?? null,
    // `sha256` stays null here. The File row does not carry one, and computing
    // it would mean downloading the object just to freeze a reference — the
    // file id and version already identify it exactly. The column exists for
    // run inputs, which hash the buffer they were going to download anyway.
    frozenByJobType: jobType
  });

  return latest;
}

/**
 * The KRT rows this round reads, freezing them on first read.
 *
 * Held by value: `krt_data` rows are the live editing surface and have no
 * version to point at, so the snapshot IS the reference. It is small — 89 rows
 * on an average KRT, 335 on the largest seen.
 *
 * Nothing in the pipeline writes `krt_data` (only user actions do, through the
 * controllers), so handing a step a snapshot changes what it reads and nothing
 * else.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {object} [options]
 * @param {string} [options.jobType]
 * @returns {Promise<object[]>} plain row objects, empty when there is no KRT
 */
async function resolveKrtRows(submissionId, round, { jobType = null } = {}) {
  const frozen = await find(submissionId, round, INPUT_KINDS.KRT);
  if (frozen) return frozen.payload || [];

  const rows = await KRTData.findAll({
    where: { submissionId, round },
    order: [['createdAt', 'ASC']]
  });
  const snapshot = rows.map((r) => r.toJSON());

  const created = await createOrRead({
    submissionId,
    round,
    inputKind: INPUT_KINDS.KRT,
    payload: snapshot,
    rowCount: snapshot.length,
    frozenByJobType: jobType
  });

  // Use whatever the round settled on, which may be another step's snapshot.
  return created.payload || [];
}

/**
 * Drop freezes so the next reader takes a fresh one.
 *
 * The rule: an input is re-frozen only when EVERY step that reads it is being
 * re-run. Restarting Markdown Convert cascades through every markdown reader,
 * so the markdown freeze goes. Restarting one detector does not — the other
 * detectors keep results built from the frozen markdown, and re-freezing would
 * hand the restarted one a different document from its siblings, which is the
 * split this file exists to prevent.
 *
 * @param {string} submissionId
 * @param {number} round
 * @param {string[]} restartingJobTypes - the step being restarted and its cascade
 * @param {Map<string, string[]>} readersByInput - input kind → every step that reads it
 * @returns {Promise<string[]>} the input kinds actually cleared
 */
async function releaseForRestart(submissionId, round, restartingJobTypes, readersByInput) {
  const restarting = new Set(restartingJobTypes);
  const releasable = [];

  for (const [inputKind, readers] of readersByInput) {
    if (!readers.length) continue;
    if (readers.every((jobType) => restarting.has(jobType))) releasable.push(inputKind);
  }
  if (!releasable.length) return [];

  const removed = await SubmissionInputFreeze.destroy({
    where: { submissionId, round, inputKind: { [Op.in]: releasable } }
  });
  if (removed) {
    logger.info('Input freezes released for a restart', {
      submissionId, round, inputKinds: releasable, restarting: restartingJobTypes
    });
  }
  return releasable;
}

/**
 * Everything this round has frozen, and whether the live data has moved on.
 *
 * This is what lets the app say "this analysis used an earlier version of your
 * data" instead of showing a result beside inputs that no longer match it.
 *
 * @param {string} submissionId
 * @param {number} round
 * @returns {Promise<object[]>} one entry per frozen input, each with `stale`
 */
async function describe(submissionId, round) {
  const freezes = await SubmissionInputFreeze.findAll({
    where: { submissionId, round },
    order: [['frozenAt', 'ASC']]
  });

  return Promise.all(freezes.map(async (freeze) => {
    const base = {
      inputKind: freeze.inputKind,
      frozenAt: freeze.frozenAt,
      frozenByJobType: freeze.frozenByJobType,
      version: freeze.fileVersion,
      rowCount: freeze.rowCount
    };

    if (freeze.inputKind === INPUT_KINDS.KRT) {
      const liveCount = await KRTData.count({ where: { submissionId, round } });
      // A count is a weak comparison and deliberately so: an edited cell does
      // not change it. Claiming "unchanged" from a count alone would be worse
      // than saying nothing, so this reports only what it can stand behind —
      // rows added or removed since the run.
      return { ...base, liveRowCount: liveCount, stale: liveCount !== freeze.rowCount };
    }

    const fileType = FILE_TYPE_FOR_KIND[freeze.inputKind];
    const latest = await File.findOne({
      where: { submissionId, type: fileType, round },
      order: [['version', 'DESC']]
    });
    return {
      ...base,
      liveVersion: latest?.version ?? null,
      stale: !!latest && latest.id !== freeze.fileId
    };
  }));
}

/**
 * Forget everything this round froze. Used when a round restarts wholesale.
 *
 * @param {string} submissionId
 * @param {number} round
 */
async function releaseAll(submissionId, round) {
  await SubmissionInputFreeze.destroy({ where: { submissionId, round } });
}

module.exports = {
  INPUT_KINDS,
  resolveFile,
  resolveKrtRows,
  releaseForRestart,
  releaseAll,
  describe,
  // exported for tests
  find,
  sequelize
};
