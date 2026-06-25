/**
 * KRT Service - API client for Key Resources Table operations
 *
 * @module services/krt
 */

import api from './api'

export default {
  /**
   * Get KRT data for a submission
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - KRT data with rows and validation info
   */
  async getData(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/krt`)
    return response.data
  },

  /**
   * Upload a KRT file (CSV/Excel)
   * @param {string} submissionId - The submission ID
   * @param {File} file - The file to upload
   * @returns {Promise<Object>} - Upload result
   */
  async upload(submissionId, file) {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post(`/submissions/${submissionId}/krt/upload`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 120000 // 2 minutes for file uploads
    })
    return response.data
  },

  /**
   * Update a specific row in the KRT
   * @param {string} submissionId - The submission ID
   * @param {string} rowId - The row UUID to update
   * @param {Object} data - Update data with column and value
   * @returns {Promise<Object>} - Updated row data
   */
  async updateRow(submissionId, rowId, data) {
    const response = await api.patch(`/submissions/${submissionId}/krt/${rowId}`, data)
    return response.data
  },

  /**
   * Add a new row to the KRT
   * @param {string} submissionId - The submission ID
   * @param {Object} data - Row data with resourceType, resourceName, etc.
   * @returns {Promise<Object>} - Created row data
   */
  async addRow(submissionId, data) {
    const response = await api.post(`/submissions/${submissionId}/krt/row`, data)
    return response.data
  },

  /**
   * Delete a row from the KRT
   * @param {string} submissionId - The submission ID
   * @param {string} rowId - The row UUID to delete
   * @param {Object} options - Optional parameters including source
   * @param {string} options.source - Change source ('manual', 'ai_suggestion', 'krt_validation')
   * @returns {Promise<Object>} - Deletion result
   */
  async deleteRow(submissionId, rowId, options = {}) {
    const response = await api.delete(`/submissions/${submissionId}/krt/${rowId}`, {
      data: options
    })
    return response.data
  },

  /**
   * Merge several rows into one (transactional on the backend).
   * @param {string} submissionId - The submission ID
   * @param {string[]} rowIds - The row UUIDs to merge
   * @param {Object} merged - The merged row values
   * @returns {Promise<Object>} - The created merged row
   */
  async mergeRows(submissionId, rowIds, merged) {
    const response = await api.post(`/submissions/${submissionId}/krt/merge`, { rowIds, merged })
    return response.data
  },

  /**
   * Validate the KRT data
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - Validation results with errors/warnings
   */
  async validate(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/krt/validate`)
    return response.data
  },

  /**
   * Pre-flight check that a KRT file is properly formatted. Stateless —
   * no submission is created. Returns { valid: true } on success or throws
   * an axios error with { valid: false, error, missingColumns } in the
   * response body when the headers are missing.
   * @param {File} file
   * @returns {Promise<{ valid: boolean }>}
   */
  async validateFormat(file) {
    const formData = new FormData()
    formData.append('file', file)
    const response = await api.post('/krt/validate-format', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000
    })
    return response.data
  },

  /**
   * Download KRT as CSV or Excel
   * @param {string} submissionId - The submission ID
   * @param {string} format - 'csv' or 'xlsx'
   * @param {number} [round] - Optional round/version number
   * @returns {Promise<Blob>} - File blob
   */
  async download(submissionId, format = 'csv', round) {
    const params = { format }
    if (round !== undefined) params.round = round
    const response = await api.get(`/submissions/${submissionId}/krt/download`, {
      params,
      responseType: 'blob'
    })
    return response.data
  }
}
