/**
 * KRT Data Model
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const KRTData = sequelize.define('KRTData', {
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
    resourceType: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'resource_type'
    },
    resourceName: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'resource_name'
    },
    source: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    identifier: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    newReuse: {
      type: DataTypes.STRING(10),
      allowNull: true,
      field: 'new_reuse'
    },
    additionalInformation: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'additional_information'
    },
    parsedIdentifiers: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      field: 'parsed_identifiers'
    },
    round: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    },
    originRowId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'origin_row_id',
      references: {
        model: 'krt_data',
        key: 'id'
      }
    }
  }, {
    tableName: 'krt_data',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['submission_id'] },
      { fields: ['submission_id', 'round'] }
    ]
  });

  // Instance methods
  KRTData.prototype.toKRTRow = function() {
    return {
      id: this.id,
      'RESOURCE TYPE': this.resourceType,
      'RESOURCE NAME': this.resourceName,
      'SOURCE': this.source,
      'IDENTIFIER': this.identifier,
      'NEW/REUSE': this.newReuse,
      'ADDITIONAL INFORMATION': this.additionalInformation,
      parsedIdentifiers: this.parsedIdentifiers,
      round: this.round,
      originRowId: this.originRowId
    };
  };

  // Class methods
  KRTData.fromKRTRow = function(row, submissionId, round = 1) {
    return {
      submissionId,
      round,
      resourceType: row['RESOURCE TYPE'] || row.resourceType || null,
      resourceName: row['RESOURCE NAME'] || row.resourceName || null,
      source: row['SOURCE'] || row.source || null,
      identifier: row['IDENTIFIER'] || row.identifier || null,
      newReuse: row['NEW/REUSE'] || row.newReuse || null,
      additionalInformation: row['ADDITIONAL INFORMATION'] || row.additionalInformation || null
    };
  };

  return KRTData;
};
