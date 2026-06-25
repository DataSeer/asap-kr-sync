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
   * Re-run the LM comparison job to (re)generate suggestions. Returns once the
   * job is queued; poll suggestions / job status for the result.
   * @param {string} submissionId
   * @returns {Promise<{ message: string, jobId: string }>}
   */
  async regenerate(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/suggestions/regenerate`)
    return response.data
  },

  /**
   * Approve a suggestion
   * @param {string} submissionId
   * @param {string} suggestionId
   * @param {string|null} modifiedValue - Optional modified value (edit suggestions)
   * @param {object|null} overrides - Optional per-field overrides for add_row
   *   suggestions (e.g. { resourceType: 'Antibody' }).
   * @returns {Promise<object>}
   */
  async approveSuggestion(submissionId, suggestionId, modifiedValue = null, overrides = null) {
    const body = { suggestionId, modifiedValue }
    if (overrides && Object.keys(overrides).length > 0) body.overrides = overrides
    const response = await api.post(`/submissions/${submissionId}/suggestions/approve`, body)
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
  },

  /**
   * Bulk-approve multiple suggestions in a single request.
   * @param {string} submissionId
   * @param {Array<{ suggestionId: string, modifiedValue?: string, overrides?: object }>} items
   * @returns {Promise<object>}
   */
  async bulkApprove(submissionId, items) {
    const response = await api.post(`/submissions/${submissionId}/suggestions/bulk-approve`, { items })
    return response.data
  },

  /**
   * Bulk-reject multiple suggestions in a single request.
   * @param {string} submissionId
   * @param {Array<{ suggestionId: string, reason?: string }>} items
   * @returns {Promise<object>}
   */
  async bulkReject(submissionId, items) {
    const response = await api.post(`/submissions/${submissionId}/suggestions/bulk-reject`, { items })
    return response.data
  }
}
