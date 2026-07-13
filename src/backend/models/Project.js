/**
 * Project Model
 * An ASAP project (grant), identified by its 2-letter code (e.g. "WH", "CS").
 * The code is the prefix of a manuscript ID and is stored on submissions as
 * `project`. This is reference data used to label/validate a submission's
 * project and to power the dashboard's project filter. It does NOT drive
 * visibility (teams do).
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Project = sequelize.define('Project', {
    code: {
      type: DataTypes.STRING(10),
      primaryKey: true,
      validate: {
        notEmpty: true
      }
    },
    piName: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'pi_name'
    },
    title: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    tableName: 'projects',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      { fields: ['active'] }
    ]
  });

  /**
   * Get all active project codes.
   */
  Project.getActiveCodes = async function() {
    const projects = await this.findAll({
      where: { active: true },
      attributes: ['code'],
      order: [['code', 'ASC']]
    });
    return projects.map(p => p.code);
  };

  return Project;
};
