/**
 * UserTeam Model
 * Join table for many-to-many relationship between users and teams
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserTeam = sequelize.define('UserTeam', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id'
    },
    team: {
      type: DataTypes.STRING(10),
      allowNull: false,
      validate: {
        notEmpty: true
      }
    }
  }, {
    tableName: 'user_teams',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['team'] },
      { fields: ['user_id', 'team'], unique: true }
    ]
  });

  return UserTeam;
};
