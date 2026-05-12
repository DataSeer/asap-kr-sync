/**
 * Submission Service - API client for submission CRUD operations
 *
 * @module services/submission
 */

import api from './api'

export default {
  /**
   * List submissions with optional filters and pagination
   * @param {Object} params - Query parameters (status, team, userId, page, limit)
   * @returns {Promise<Object>} - Submissions list with pagination
   */
  async list(params = {}) {
    const response = await api.get('/submissions', { params })
    return response.data
  },

  /**
   * Get a single submission by ID
   * @param {string} id - The submission ID
   * @returns {Promise<Object>} - Submission details
   */
  async getById(id) {
    const response = await api.get(`/submissions/${id}`)
    return response.data
  },

  /**
   * Create a new submission
   * @param {Object} data - Submission data (title, manuscriptId, dataAvailabilityStatement)
   * @returns {Promise<Object>} - Created submission
   */
  async create(data) {
    const response = await api.post('/submissions', data)
    return response.data
  },

  /**
   * Update a submission
   * @param {string} id - The submission ID
   * @param {Object} data - Fields to update
   * @returns {Promise<Object>} - Updated submission
   */
  async update(id, data) {
    const response = await api.patch(`/submissions/${id}`, data)
    return response.data
  },

  /**
   * Delete a submission
   * @param {string} id - The submission ID
   * @returns {Promise<Object>} - Deletion result
   */
  async delete(id) {
    const response = await api.delete(`/submissions/${id}`)
    return response.data
  },

  /**
   * Get change history for a submission
   * @param {string} id - The submission ID
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} - Change history
   */
  async getChanges(id, params = {}) {
    const response = await api.get(`/submissions/${id}/changes`, { params })
    return response.data
  },

  /**
   * Hide a submission from the user's view
   * @param {string} id - The submission ID
   * @returns {Promise<Object>} - Result
   */
  async hide(id) {
    const response = await api.post(`/submissions/${id}/hide`)
    return response.data
  },

  /**
   * Unhide a previously hidden submission
   * @param {string} id - The submission ID
   * @returns {Promise<Object>} - Result
   */
  async unhide(id) {
    const response = await api.post(`/submissions/${id}/unhide`)
    return response.data
  },

  /**
   * List hidden submissions for the current user
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} - Hidden submissions list
   */
  async listHidden(params = {}) {
    const response = await api.get('/submissions/hidden', { params })
    return response.data
  },

  /**
   * Get available filter options (teams, users)
   * @returns {Promise<Object>} - Filter options for dropdowns
   */
  async getFilterOptions() {
    const response = await api.get('/submissions/filter-options')
    return response.data
  },

  /**
   * Upload a supplemental methods file (PDF or Word)
   * @param {string} id - The submission ID
   * @param {File} file - The file to upload
   * @returns {Promise<Object>} - Upload result
   */
  async uploadSupplemental(id, file) {
    const formData = new FormData()
    formData.append('file', file)
    const response = await api.post(`/submissions/${id}/supplemental/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000
    })
    return response.data
  },

  /**
   * Process a new version (start a new round)
   * @param {string} id - The submission ID
   * @param {Object} data - { dataAvailabilityStatement, hasNewKRT }
   * @returns {Promise<Object>} - Updated submission
   */
  async processNewVersion(id, data) {
    const response = await api.post(`/submissions/${id}/new-round`, data)
    return response.data
  }
}
