/**
 * File Model
 */

const { DataTypes } = require('sequelize');
const { FILE_TYPES } = require('../config/constants');

module.exports = (sequelize) => {
  const File = sequelize.define('File', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id',
      references: {
        model: 'submissions',
        key: 'id'
      }
    },
    type: {
      type: DataTypes.ENUM(...Object.values(FILE_TYPES)),
      allowNull: false
    },
    fileName: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'file_name'
    },
    s3Key: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 's3_key'
    },
    mimeType: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'mime_type'
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    }
  }, {
    tableName: 'files',
    timestamps: true,
    underscored: true,
    updatedAt: false, // Files are immutable once created
    indexes: [
      { fields: ['submission_id'] },
      { fields: ['submission_id', 'type'] },
      { fields: ['submission_id', 'type', 'version'] }
    ]
  });

  // Class methods
  // `version` is scoped to (submissionId, type, round): each round restarts
  // its upload counter at 1 for a given type. `round` is required so callers
  // can't accidentally compute a global counter and reintroduce the
  // round/version drift bug.
  File.getLatestVersion = async function(submissionId, type, round) {
    if (round === undefined || round === null) {
      throw new Error('File.getLatestVersion: round is required');
    }
    const latest = await File.findOne({
      where: { submissionId, type, round },
      order: [['version', 'DESC']]
    });
    return latest ? latest.version : 0;
  };

  return File;
};
