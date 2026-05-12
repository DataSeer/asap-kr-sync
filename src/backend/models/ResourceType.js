/**
 * ResourceType Model
 * Stores resource type names for KRT validation
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ResourceType = sequelize.define('ResourceType', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true
      }
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    type: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'lab_material',
      validate: {
        isIn: [['dataset', 'software', 'protocol', 'lab_material']]
      }
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'sort_order'
    }
  }, {
    tableName: 'resource_types',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      { fields: ['name'], unique: true },
      { fields: ['active'] },
      { fields: ['sort_order'] }
    ]
  });

  /**
   * Get all active resource type names, sorted by sort_order
   * @returns {Promise<string[]>}
   */
  ResourceType.getActiveNames = async function() {
    const types = await this.findAll({
      where: { active: true },
      attributes: ['name'],
      order: [['sortOrder', 'ASC']]
    });
    return types.map(t => t.name);
  };

  /**
   * Get all active resource types with name and type, sorted by sort_order.
   * Used by the frontend to build the type→group mapping dynamically.
   * @returns {Promise<Array<{ name: string, type: string }>>}
   */
  ResourceType.getActiveWithType = async function() {
    const types = await this.findAll({
      where: { active: true },
      attributes: ['name', 'type'],
      order: [['sortOrder', 'ASC']]
    });
    return types.map(t => ({ name: t.name, type: t.type }));
  };

  return ResourceType;
};
