/**
 * SubmissionArchive — the tombstone left where a submission was.
 *
 * A dashboard that silently loses a submission is alarming; a row saying
 * "archived on 3 March, restorable, checksum abc123" is not.
 *
 * It has no foreign key to `submissions`, and that is the point: the row exists
 * precisely because the submission does not. It also OUTLIVES a restore —
 * "archived in March, restored in May" is a truer record than a row that
 * disappears, and once the archive folder is gone it is the only place that
 * history exists.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const SubmissionArchive = sequelize.define('SubmissionArchive', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    /** A plain UUID, not a reference: what it names is gone. */
    submissionId: { type: DataTypes.UUID, allowNull: false, field: 'submission_id' },
    manuscriptId: { type: DataTypes.STRING(100), allowNull: true, field: 'manuscript_id' },
    /** Kept so a list reads without opening every archive. */
    title: { type: DataTypes.TEXT, allowNull: true },

    archivedAt: { type: DataTypes.DATE, allowNull: false, field: 'archived_at' },
    archivedByUserId: {
      type: DataTypes.UUID, allowNull: true, field: 'archived_by_user_id',
      references: { model: 'users', key: 'id' }
    },

    location: { type: DataTypes.TEXT, allowNull: false },
    /**
     * Of the manifest.
     *
     * The manifest proves the archive is internally consistent; this proves the
     * FILE somebody is holding is the one that was made. A tombstone naming an
     * archive nobody can verify is a promise, not a record.
     */
    manifestSha256: { type: DataTypes.STRING(64), allowNull: false, field: 'manifest_sha256' },
    contents: { type: DataTypes.JSONB, allowNull: true },

    restoredAt: { type: DataTypes.DATE, allowNull: true, field: 'restored_at' },
    restoredByUserId: {
      type: DataTypes.UUID, allowNull: true, field: 'restored_by_user_id',
      references: { model: 'users', key: 'id' }
    }
  }, {
    tableName: 'submission_archives',
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ['submission_id'] }, { fields: ['archived_at'] }]
  });

  /**
   * Tombstones for submissions that are NOT currently here.
   *
   * A restored submission keeps its tombstone — the history is worth more than
   * the tidiness — so a list of "what is missing" has to exclude the ones that
   * came back.
   *
   * @returns {Promise<SubmissionArchive[]>}
   */
  SubmissionArchive.listMissing = async function() {
    return SubmissionArchive.findAll({
      where: { restoredAt: null },
      order: [['archivedAt', 'DESC']]
    });
  };

  return SubmissionArchive;
};
