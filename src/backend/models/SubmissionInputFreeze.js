/**
 * SubmissionInputFreeze — what one round is being processed from.
 *
 * One row per (submission, round, input kind), created by the FIRST step that
 * reads that input. Every later reader in the round is handed the same thing,
 * so a file replaced mid-run cannot split a round in two.
 *
 * The freeze LEVELS are not configured anywhere; they fall out of the
 * dependency graph. The PDF is frozen by Markdown Convert, which starts the
 * round. The KRT is frozen by the first detector, and the detectors are gated
 * on `krt_curated` — so the KRT freezes after the author has validated it,
 * which is exactly where it should.
 *
 * Files are held by reference; a File row is immutable once written. The KRT is
 * held by value, because `krt_data` rows are the live editing surface and have
 * no version to point at.
 */

const { DataTypes } = require('sequelize');

/** The inputs a pipeline step can read. */
const INPUT_KINDS = {
  PDF: 'pdf',
  MARKDOWN: 'markdown',
  KRT: 'krt'
};

module.exports = (sequelize) => {
  const SubmissionInputFreeze = sequelize.define('SubmissionInputFreeze', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id',
      references: { model: 'submissions', key: 'id' }
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    inputKind: {
      type: DataTypes.STRING(32),
      allowNull: false,
      field: 'input_kind'
    },

    // ── File inputs, by reference ────────────────────────────────────────────
    fileId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'file_id',
      references: { model: 'files', key: 'id' }
    },
    /**
     * Copied from the file rather than joined. "What did this run read" has to
     * survive the file row being removed — a NULLed `file_id` would otherwise
     * erase the only record of it.
     */
    fileVersion: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'file_version'
    },
    s3Key: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 's3_key'
    },
    sha256: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    bytes: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    // ── Row inputs, by value ─────────────────────────────────────────────────
    payload: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    rowCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'row_count'
    },

    /**
     * Which step read it first. Kept for the re-freeze rule rather than for
     * display: an input is re-frozen only when every step that reads it is
     * being re-run.
     */
    frozenByJobType: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'frozen_by_job_type'
    },
    frozenAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'frozen_at'
    }
  }, {
    tableName: 'submission_input_freezes',
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['submission_id', 'round', 'input_kind'],
        name: 'submission_input_freezes_unique_per_round'
      },
      { fields: ['submission_id', 'round'] }
    ]
  });

  SubmissionInputFreeze.INPUT_KINDS = INPUT_KINDS;

  return SubmissionInputFreeze;
};

module.exports.INPUT_KINDS = INPUT_KINDS;
