/**
 * User Model
 */

const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const { ROLES } = require('../config/constants');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true
      },
      set(value) {
        this.setDataValue('email', value.toLowerCase().trim());
      }
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'password_hash'
    },
    auth0Sub: {
      type: DataTypes.STRING(255),
      allowNull: true,
      unique: true,
      field: 'auth0_sub'
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        len: [2, 100]
      }
    },
    role: {
      type: DataTypes.ENUM(...Object.values(ROLES)),
      allowNull: false,
      defaultValue: ROLES.AUTHOR
    },
  }, {
    tableName: 'users',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['email'], unique: true },
      { fields: ['role'] }
    ]
  });

  // Instance methods
  User.prototype.toJSON = function() {
    const values = { ...this.get() };
    delete values.passwordHash;
    delete values.auth0Sub;
    values.isAuth0User = !!this.auth0Sub;
    return values;
  };

  User.prototype.verifyPassword = async function(password) {
    if (!this.passwordHash) return false;
    return bcrypt.compare(password, this.passwordHash);
  };

  // Class methods
  User.hashPassword = async function(password) {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  };

  // Detect already-hashed bcrypt strings precisely (algo, cost, 22-char salt
  // + 31-char hash = 53 chars after the cost prefix). A startsWith('$2')
  // check would skip hashing for any password coincidentally starting
  // with "$2".
  const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$.{53}$/;
  function isBcryptHash(s) {
    return typeof s === 'string' && BCRYPT_HASH_RE.test(s);
  }

  // Hooks
  User.beforeCreate(async (user) => {
    if (user.passwordHash && !isBcryptHash(user.passwordHash)) {
      user.passwordHash = await User.hashPassword(user.passwordHash);
    }
  });

  User.beforeUpdate(async (user) => {
    if (user.changed('passwordHash') && !isBcryptHash(user.passwordHash)) {
      user.passwordHash = await User.hashPassword(user.passwordHash);
    }
  });

  return User;
};
