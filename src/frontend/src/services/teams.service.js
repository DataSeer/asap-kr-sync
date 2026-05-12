/**
 * Teams Service
 */

import api from './api'

export default {
  /**
   * List all teams
   * @param {object} params - { page?, limit?, active? }
   */
  async list(params = {}) {
    const response = await api.get('/teams', { params })
    return response.data
  },

  /**
   * Get active team codes (for dropdowns)
   */
  async getCodes() {
    const response = await api.get('/teams/codes')
    return response.data
  },

  /**
   * Get team by ID
   * @param {string} id - Team ID
   */
  async getById(id) {
    const response = await api.get(`/teams/${id}`)
    return response.data
  },

  /**
   * Create a new team
   * @param {object} data - { code, name? }
   */
  async create(data) {
    const response = await api.post('/teams', data)
    return response.data
  },

  /**
   * Update team
   * @param {string} id - Team ID
   * @param {object} data - { code?, name?, active? }
   */
  async update(id, data) {
    const response = await api.patch(`/teams/${id}`, data)
    return response.data
  },

  /**
   * Delete team
   * @param {string} id - Team ID
   */
  async delete(id) {
    const response = await api.delete(`/teams/${id}`)
    return response.data
  }
}
