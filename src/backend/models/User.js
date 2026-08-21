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
    /**
     * Anonymised rather than removed.
     *
     * The row has to survive: `submissions.user_id` and `change_logs.user_id`
     * are ON DELETE CASCADE, so a real DELETE took the person's submissions
     * with them AND punched holes in the history of everyone else's. A deleted
     * user keeps their id and their foreign keys; what goes is the identity.
     */
    deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'users',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['email'], unique: true },
      { fields: ['role'] },
      { fields: ['deleted'] }
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

  // `user.passwordHash &&` is not redundant: anonymising an account erases the
  // hash by setting it to null, and bcrypt.hash(null) throws.
  User.beforeUpdate(async (user) => {
    if (user.changed('passwordHash') && user.passwordHash && !isBcryptHash(user.passwordHash)) {
      user.passwordHash = await User.hashPassword(user.passwordHash);
    }
  });

  return User;
};
