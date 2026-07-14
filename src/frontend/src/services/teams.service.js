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
  },

  /** Download all teams as CSV text */
  async exportCsv() {
    const response = await api.get('/teams/export', { responseType: 'text' })
    return response.data
  },

  /**
   * Upsert teams from parsed CSV rows
   * @param {Array<{code, name?, active?}>} teams
   */
  async importCsv(teams) {
    const response = await api.post('/teams/import', { teams })
    return response.data
  },

  /**
   * List (team, email) roster mappings
   * @param {object} params - { page?, limit?, team?, email? }
   */
  async listEmailMappings(params = {}) {
    const response = await api.get('/teams/email-mappings', { params })
    return response.data
  },

  /**
   * Bulk-create (team, email) roster mappings
   * @param {Array<{team: string, email: string}>} mappings
   */
  async createEmailMappings(mappings) {
    const response = await api.post('/teams/email-mappings', { mappings })
    return response.data
  },

  /**
   * Delete a roster mapping
   * @param {string} id - Mapping ID
   */
  async deleteEmailMapping(id) {
    const response = await api.delete(`/teams/email-mappings/${id}`)
    return response.data
  },

  /**
   * Download the full (team, email) roster as CSV text
   * @returns {Promise<string>}
   */
  async exportEmailMappings() {
    const response = await api.get('/teams/email-mappings/export', { responseType: 'text' })
    return response.data
  }
}
