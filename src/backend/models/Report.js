/**
 * Report Model
 */

const { DataTypes } = require('sequelize');
const { REPORT_TYPES } = require('../config/constants');

module.exports = (sequelize) => {
  const Report = sequelize.define('Report', {
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
      type: DataTypes.ENUM(...Object.values(REPORT_TYPES)),
      allowNull: false
    },
    fileUrl: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      field: 'file_url'
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    }
  }, {
    tableName: 'reports',
    timestamps: true,
    underscored: true,
    updatedAt: false,
    indexes: [
      { fields: ['submission_id'] },
      { fields: ['submission_id', 'type'] }
    ]
  });

  // Class methods
  Report.getLatestByType = async function(submissionId, type) {
    return Report.findOne({
      where: { submissionId, type },
      order: [['createdAt', 'DESC']]
    });
  };

  return Report;
};
