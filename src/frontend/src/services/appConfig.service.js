/**
 * App Config Service
 */

import api from './api'

export default {
  /**
   * List all configs
   * @param {object} params - { page?, limit?, category? }
   */
  async list(params = {}) {
    const response = await api.get('/app-config', { params })
    return response.data
  },

  /**
   * Get config by key
   * @param {string} key - Config key
   */
  async getByKey(key) {
    const response = await api.get(`/app-config/${key}`)
    return response.data
  },

  /**
   * Create or update config
   * @param {object} data - { key, value, description?, category? }
   */
  async upsert(data) {
    const response = await api.put('/app-config', data)
    return response.data
  },

  /**
   * Delete config
   * @param {string} key - Config key
   */
  async delete(key) {
    const response = await api.delete(`/app-config/${key}`)
    return response.data
  }
}
