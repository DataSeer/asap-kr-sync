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
    project: {
      type: DataTypes.STRING(10),
      allowNull: true
      // The 2-letter grant code, extracted from the manuscript ID. Validated at
      // controller level against the projects table. Used as a filter only —
      // visibility is driven by the owner's teams, not the project.
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
    /**
     * When the author confirmed the Availability Statement.
     *
     * `das_suggestions` is the only module that reads the statement, and it
     * waits for this — the extractor's answer is a proposal, and running before
     * anyone has looked spends a model call on text that may be the wrong
     * paragraph. Cleared whenever the statement is edited, so a changed
     * statement is re-confirmed rather than silently re-used.
     *
     * A timestamp rather than a boolean: "when was this agreed, and by whom" is
     * what an audit asks, and a boolean cannot answer it.
     */
    dasConfirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'das_confirmed_at'
    },
    dasConfirmedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'das_confirmed_by_user_id',
      references: { model: 'users', key: 'id' }
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
    /**
     * Which detection pipeline analysed this submission (`config/pipelines.js`).
     *
     * Always stamped on creation, the default included. `getPipeline(null)`
     * resolves to whatever the default is *now*, so a null row would start
     * claiming a different pipeline the day the default changes. NULL means
     * only "created before this column existed".
     *
     * Set once, when the submission is created, and never afterwards: the
     * strategies decide what the detectors are shown, so changing it mid-flight
     * would leave some steps detected blind and some seeded with nothing
     * recording the split — the same fault `submission_input_freezes` exists to
     * prevent for documents.
     */
    pipelineId: {
      type: DataTypes.STRING(32),
      allowNull: true,
      defaultValue: null,
      field: 'pipeline_id'
    },
  }, {
    tableName: 'submissions',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['project'] },
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
