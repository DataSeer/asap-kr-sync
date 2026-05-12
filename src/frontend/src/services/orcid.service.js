/**
 * ORCID Service - API client for author ORCID extraction results
 *
 * @module services/orcid
 */

import api from './api'

export default {
  /**
   * Get authors with ORCIDs for a submission
   * @param {string} submissionId
   * @returns {Promise<{ authors: Array, meta: object|null }>}
   */
  async getAuthors(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/authors`)
    return response.data
  },

  /**
   * Trigger ORCID extraction (manual re-run)
   * @param {string} submissionId
   * @returns {Promise<object>}
   */
  async triggerExtraction(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/authors/extract`)
    return response.data
  }
}
