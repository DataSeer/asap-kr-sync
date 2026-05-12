/**
 * UserHiddenSubmission Model
 * Tracks which submissions each user has hidden from their view
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserHiddenSubmission = sequelize.define('UserHiddenSubmission', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id'
    },
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id'
    }
  }, {
    tableName: 'user_hidden_submissions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['submission_id'] },
      { fields: ['user_id', 'submission_id'], unique: true }
    ]
  });

  return UserHiddenSubmission;
};
