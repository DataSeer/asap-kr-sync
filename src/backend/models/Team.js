/**
 * Team Model
 * A team is a lab, identified by its leader's name (e.g. "Alessi", "Wood").
 * Users belong to one or more teams; team membership drives submission
 * visibility. The unique `code` column holds the team name (kept as the key
 * so user_teams / team_emails FKs reference it); `name` is an optional label.
 * (The 2-letter grant code lives in the separate `projects` table.)
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
      type: DataTypes.STRING(100),
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
   * Get all active team names (stored in the `code` column).
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
