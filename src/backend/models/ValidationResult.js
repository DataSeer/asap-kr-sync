/**
 * Validation Result Model
 */

const { DataTypes } = require('sequelize');
const { VALIDATION_SEVERITY } = require('../config/constants');

module.exports = (sequelize) => {
  const ValidationResult = sequelize.define('ValidationResult', {
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
    rowId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'row_id',
      references: {
        model: 'krt_data',
        key: 'id'
      }
    },
    columnName: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'column_name'
    },
    errorType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'error_type'
    },
    errorMessage: {
      type: DataTypes.STRING(500),
      allowNull: false,
      field: 'error_message'
    },
    severity: {
      type: DataTypes.ENUM(...Object.values(VALIDATION_SEVERITY)),
      allowNull: false,
      defaultValue: VALIDATION_SEVERITY.ERROR
    },
    suggestion: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    }
  }, {
    tableName: 'validation_results',
    timestamps: true,
    underscored: true,
    updatedAt: false,
    indexes: [
      { fields: ['submission_id'] },
      { fields: ['submission_id', 'row_id'] },
      { fields: ['submission_id', 'severity'] }
    ]
  });

  // Class methods
  ValidationResult.clearForSubmission = async function(submissionId, round) {
    const where = { submissionId };
    if (round !== undefined) {
      where.round = round;
    }
    return ValidationResult.destroy({ where });
  };

  ValidationResult.getErrorCount = async function(submissionId) {
    return ValidationResult.count({
      where: {
        submissionId,
        severity: VALIDATION_SEVERITY.ERROR
      }
    });
  };

  return ValidationResult;
};
