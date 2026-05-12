/**
 * RejectedResource Model
 *
 * One row per suggestion the user explicitly rejected. The diff-based
 * /suggestions API filters these out at read time so the rejected suggestion
 * does not reappear. Round-scoped (rejection in round 1 doesn't affect round 2).
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const RejectedResource = sequelize.define('RejectedResource', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    submissionId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'submission_id'
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    suggestionId: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'suggestion_id'
    },
    dedupKey: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'dedup_key'
    },

    // Audit snapshot — what the user actually saw when they rejected.
    resourceType:   { type: DataTypes.TEXT, allowNull: true, field: 'resource_type' },
    resourceName:   { type: DataTypes.TEXT, allowNull: true, field: 'resource_name' },
    identifier:     { type: DataTypes.TEXT, allowNull: true },
    newReuse:       { type: DataTypes.TEXT, allowNull: true, field: 'new_reuse' },
    proposedValue:  { type: DataTypes.TEXT, allowNull: true, field: 'proposed_value' },
    columnName:     { type: DataTypes.TEXT, allowNull: true, field: 'column_name' },

    reason:     { type: DataTypes.TEXT, allowNull: true },
    rejectedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'rejected_at' },
    rejectedBy: { type: DataTypes.UUID, allowNull: true, field: 'rejected_by' }
  }, {
    tableName: 'rejected_resources',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['submission_id', 'round'] },
      { unique: true, fields: ['submission_id', 'round', 'suggestion_id'] }
    ]
  });

  /**
   * Get every rejection for a submission/round.
   * @param {string} submissionId
   * @param {number} round
   * @returns {Promise<RejectedResource[]>}
   */
  RejectedResource.getForSubmission = async function(submissionId, round) {
    return RejectedResource.findAll({
      where: { submissionId, round },
      order: [['rejected_at', 'DESC']]
    });
  };

  return RejectedResource;
};
