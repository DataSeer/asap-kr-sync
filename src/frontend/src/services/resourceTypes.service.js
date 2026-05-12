/**
 * Resource Types Service
 */

import api from './api'

export default {
  /**
   * List all resource types
   * @param {object} params - { page?, limit?, active? }
   */
  async list(params = {}) {
    const response = await api.get('/resource-types', { params })
    return response.data
  },

  /**
   * Get active resource type names (for dropdowns)
   */
  async getNames() {
    const response = await api.get('/resource-types/names')
    return response.data
  },

  /**
   * Get resource type by ID
   * @param {string} id - Resource type ID
   */
  async getById(id) {
    const response = await api.get(`/resource-types/${id}`)
    return response.data
  },

  /**
   * Create a new resource type
   * @param {object} data - { name, description?, active?, sortOrder? }
   */
  async create(data) {
    const response = await api.post('/resource-types', data)
    return response.data
  },

  /**
   * Update resource type
   * @param {string} id - Resource type ID
   * @param {object} data - { name?, description?, active?, sortOrder? }
   */
  async update(id, data) {
    const response = await api.patch(`/resource-types/${id}`, data)
    return response.data
  },

  /**
   * Delete resource type
   * @param {string} id - Resource type ID
   */
  async delete(id) {
    const response = await api.delete(`/resource-types/${id}`)
    return response.data
  },

  async exportCsv() {
    const { data } = await api.get('/resource-types/export', { responseType: 'blob' })
    return data
  },

  async importEntries(entries, mode = 'append') {
    const { data } = await api.post('/resource-types/import', { entries, mode })
    return data
  }
}
