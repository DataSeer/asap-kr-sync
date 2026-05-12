/**
 * Submission Model
 */

const { DataTypes } = require('sequelize');
const { SUBMISSION_STATUSES } = require('../config/constants');

module.exports = (sequelize) => {
  const Submission = sequelize.define('Submission', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id',
      references: {
        model: 'users',
        key: 'id'
      }
    },
    team: {
      type: DataTypes.STRING(2),
      allowNull: true
      // Team validation is done at controller level using dynamic values from DB
    },
    title: {
      type: DataTypes.STRING(500),
      allowNull: false,
      validate: {
        len: [1, 500]
      }
    },
    manuscriptId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'manuscript_id'
    },
    dataAvailabilityStatement: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'data_availability_statement'
    },
    extractedDataAvailabilityStatement: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'extracted_data_availability_statement'
    },
    status: {
      type: DataTypes.ENUM(...SUBMISSION_STATUSES),
      allowNull: false,
      defaultValue: 'draft'
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    currentRound: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      field: 'current_round'
    },
    authors: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
      field: 'authors'
    },
  }, {
    tableName: 'submissions',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['team'] },
      { fields: ['status'] },
      { fields: ['manuscript_id'] },
      { fields: ['created_at'] }
    ]
  });

  // Instance methods
  Submission.prototype.canTransitionTo = function(newStatus) {
    // Simple step-based transitions
    // Forward: draft → step_krt → step_pdf → step_review → step_as → step_report → completed
    // Backward: can go back to previous steps
    const transitions = {
      draft: ['step_krt'],
      step_krt: ['step_pdf', 'draft'],
      step_pdf: ['step_review', 'step_krt'],
      step_review: ['step_as', 'step_pdf'],
      step_as: ['step_report', 'step_review'],
      step_report: ['completed', 'step_as'],
      completed: ['step_report', 'step_as', 'step_review', 'step_pdf', 'step_krt'] // Allow going back to any step for revisions
    };

    return transitions[this.status]?.includes(newStatus) || false;
  };

  return Submission;
};
