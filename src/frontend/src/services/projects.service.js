/**
 * Projects Service
 */

import api from './api'

export default {
  /**
   * List projects
   * @param {object} params - { page?, limit?, active? }
   */
  async list(params = {}) {
    const response = await api.get('/projects', { params })
    return response.data
  },

  /** Active project codes (for dropdowns) */
  async getCodes() {
    const response = await api.get('/projects/codes')
    return response.data
  },

  /**
   * Create a project
   * @param {object} data - { code, piName?, title?, active? }
   */
  async create(data) {
    const response = await api.post('/projects', data)
    return response.data
  },

  /**
   * Update a project
   * @param {string} code - Project code
   * @param {object} data - { piName?, title?, active? }
   */
  async update(code, data) {
    const response = await api.patch(`/projects/${code}`, data)
    return response.data
  },

  /**
   * Delete a project
   * @param {string} code - Project code
   */
  async delete(code) {
    const response = await api.delete(`/projects/${code}`)
    return response.data
  }
}
