/**
 * AppConfig Model
 * Key-value store for application configuration
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AppConfig = sequelize.define('AppConfig', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    key: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true
      }
    },
    value: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    category: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'general'
    }
  }, {
    tableName: 'app_config',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      { fields: ['key'], unique: true },
      { fields: ['category'] }
    ]
  });

  /**
   * Get config value by key
   * @param {string} key
   * @returns {Promise<any>} The config value or null if not found
   */
  AppConfig.getValue = async function(key) {
    const config = await this.findOne({ where: { key } });
    return config ? config.value : null;
  };

  /**
   * Set config value by key
   * @param {string} key
   * @param {any} value
   * @param {object} options - { description?, category? }
   * @returns {Promise<AppConfig>}
   */
  AppConfig.setValue = async function(key, value, options = {}) {
    const [config, created] = await this.findOrCreate({
      where: { key },
      defaults: {
        value,
        description: options.description || null,
        category: options.category || 'general'
      }
    });

    if (!created) {
      config.value = value;
      if (options.description !== undefined) {
        config.description = options.description;
      }
      if (options.category !== undefined) {
        config.category = options.category;
      }
      await config.save();
    }

    return config;
  };

  return AppConfig;
};
