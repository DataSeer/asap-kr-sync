/**
 * Suggestion Service - Unified API client for suggestions from all sources
 *
 * @module services/suggestion
 */

import api from './api'

export default {
  /**
   * Get all suggestions for a submission (merged from all sources)
   * @param {string} submissionId
   * @returns {Promise<{ suggestions: Array }>}
   */
  async getSuggestions(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/suggestions`)
    return response.data
  },

  /**
   * Approve a suggestion
   * @param {string} submissionId
   * @param {string} suggestionId
   * @param {string|null} modifiedValue - Optional modified value
   * @returns {Promise<object>}
   */
  async approveSuggestion(submissionId, suggestionId, modifiedValue = null) {
    const response = await api.post(`/submissions/${submissionId}/suggestions/approve`, {
      suggestionId,
      modifiedValue
    })
    return response.data
  },

  /**
   * Reject a suggestion
   * @param {string} submissionId
   * @param {string} suggestionId
   * @param {string} reason - Rejection reason
   * @returns {Promise<object>}
   */
  async rejectSuggestion(submissionId, suggestionId, reason = '') {
    const response = await api.post(`/submissions/${submissionId}/suggestions/reject`, {
      suggestionId,
      reason
    })
    return response.data
  }
}
