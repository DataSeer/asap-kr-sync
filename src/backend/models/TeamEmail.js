/**
 * TeamEmail Model
 * Admin-managed (team, email) mapping list. When a user authenticates (or is
 * created), every mapping matching their email is applied as a UserTeam
 * membership — so ASAP PMs get their teams automatically from the ASAP team
 * roster instead of waiting for a manual assignment.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TeamEmail = sequelize.define('TeamEmail', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    team: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        isEmail: true
      },
      set(value) {
        this.setDataValue('email', typeof value === 'string' ? value.trim().toLowerCase() : value);
      }
    }
  }, {
    tableName: 'team_emails',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
    indexes: [
      { fields: ['email'] },
      { fields: ['team'] },
      { fields: ['team', 'email'], unique: true }
    ]
  });

  return TeamEmail;
};
