/**
 * RefreshToken Model
 *
 * Server-side store for refresh tokens, keyed by sha256(token). Raw tokens
 * are NEVER persisted — they only exist in the user's cookie/storage and
 * the wire. Storing only the hash means a DB leak does not allow attackers
 * to mint sessions.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const RefreshToken = sequelize.define('RefreshToken', {
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
    tokenHash: {
      type: DataTypes.CHAR(64),
      allowNull: false,
      unique: true,
      field: 'token_hash'
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'expires_at'
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'revoked_at'
    },
    replacedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'replaced_by'
    },
    // Why the row was revoked. See migration
    // 20260430120000-add-refresh-token-revoked-reason for semantics.
    // Pre-existing rows (NULL) are treated as 'rotation' (conservative
    // default — replay still triggers chain wipe).
    revokedReason: {
      type: DataTypes.STRING(32),
      allowNull: true,
      field: 'revoked_reason',
      validate: {
        isIn: [['logout', 'rotation', 'reuse_detected']]
      }
    },
    userAgent: {
      type: DataTypes.STRING(500),
      allowNull: true,
      field: 'user_agent'
    },
    ip: {
      type: DataTypes.STRING(45),
      allowNull: true
    }
  }, {
    tableName: 'refresh_tokens',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
    indexes: [
      { fields: ['token_hash'], unique: true },
      { fields: ['user_id', 'expires_at'] }
    ]
  });

  return RefreshToken;
};
