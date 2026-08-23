/**
 * Change Log Model
 */

const { DataTypes } = require('sequelize');
const { CHANGE_ACTIONS, CHANGE_SOURCES } = require('../config/constants');

module.exports = (sequelize) => {
  const ChangeLog = sequelize.define('ChangeLog', {
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
    /**
     * Null when the system is the actor.
     *
     * An automatic apply — the extractor filling an empty statement — has
     * nobody behind it. The alternatives were to invent a user or to skip the
     * log, and skipping is how those writes became invisible in the first
     * place.
     */
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'user_id',
      references: {
        model: 'users',
        key: 'id'
      }
    },
    /**
     * The execution whose output this row promoted. Null for a hand-typed edit.
     *
     * This is what makes a value's origin answerable: "the statement came from
     * run 2's extraction, accepted by Nicolas at 14:02" is one row, rather than
     * a guess from timestamps.
     */
    stepExecutionId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'step_execution_id',
      references: {
        model: 'step_executions',
        key: 'id'
      }
    },
    action: {
      type: DataTypes.ENUM(...CHANGE_ACTIONS),
      allowNull: false
    },
    source: {
      type: DataTypes.ENUM(...CHANGE_SOURCES),
      allowNull: true,
      defaultValue: null
    },
    step: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    rowId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'row_id',
      references: {
        model: 'krt_data',
        key: 'id'
      }
    },
    columnName: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'column_name'
    },
    oldValue: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'old_value'
    },
    newValue: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'new_value'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
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
    },
    /**
     * The file this entry is about, when it is about one.
     *
     * The upload entries carried only a free-text description, so the narrative
     * could not be tied to the exact version it described.
     */
    fileId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'file_id',
      references: { model: 'files', key: 'id' }
    }
  }, {
    tableName: 'change_logs',
    timestamps: true,
    underscored: true,
    updatedAt: false,
    indexes: [
      { fields: ['submission_id'] },
      { fields: ['user_id'] },
      { fields: ['submission_id', 'action'] },
      { fields: ['created_at'] },
      { fields: ['source'] },
      { fields: ['row_id'] }
    ]
  });

  // Class methods
  ChangeLog.logChange = async function(data) {
    return ChangeLog.create(data);
  };

  ChangeLog.getHistory = async function(submissionId, options = {}) {
    const { limit = 100, offset = 0, round } = options;
    const where = { submissionId };
    if (round !== undefined) {
      where.round = round;
    }
    return ChangeLog.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      include: [{
        association: 'user',
        attributes: ['id', 'name', 'email']
      }]
    });
  };

  return ChangeLog;
};
