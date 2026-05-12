/**
 * Team Model
 * Stores team codes and names for the application
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Team = sequelize.define('Team', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    code: {
      type: DataTypes.STRING(10),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true
      }
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    tableName: 'teams',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      { fields: ['code'], unique: true },
      { fields: ['active'] }
    ]
  });

  /**
   * Get all active team codes
   */
  Team.getActiveCodes = async function() {
    const teams = await this.findAll({
      where: { active: true },
      attributes: ['code'],
      order: [['code', 'ASC']]
    });
    return teams.map(t => t.code);
  };

  return Team;
};
