/**
 * EnrichmentListEntry Model
 * Consolidated reference list for all enrichment categories: software, materials, datasets, protocols.
 * Replaces the 4 separate list tables (software_list_entries, materials_list_entries, etc.).
 * Uses standardized KRT column fields for consistency.
 */

const { DataTypes } = require('sequelize');

const VALID_CATEGORIES = ['software', 'materials', 'datasets', 'protocols'];

module.exports = (sequelize) => {
  const EnrichmentListEntry = sequelize.define('EnrichmentListEntry', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    // --- Category discriminator ---
    category: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isIn: [VALID_CATEGORIES]
      }
    },
    // --- Standard KRT columns ---
    resourceType: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: 'resource_type'
    },
    resourceName: {
      type: DataTypes.STRING(1000),
      allowNull: false,
      field: 'resource_name'
    },
    source: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    identifier: {
      type: DataTypes.TEXT,
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
    // --- Enrichment matching fields ---
    suggestedEntity: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'suggested_entity'
    },
    tokens: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: []
    }
  }, {
    tableName: 'enrichment_list_entries',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['category'] },
      { fields: ['resource_type'] },
      { fields: ['resource_name'] }
    ]
  });

  /**
   * Get all resource type names for a given category.
   * @param {string} category - One of 'software', 'materials', 'datasets', 'protocols'
   * @returns {Promise<string[]>}
   */
  EnrichmentListEntry.getActiveNames = async function (category) {
    const entries = await EnrichmentListEntry.findAll({
      attributes: ['resourceType'],
      where: { category },
      group: ['resource_type'],
      raw: true
    });
    return entries.map(e => e.resourceType || e.resource_type);
  };

  return EnrichmentListEntry;
};
