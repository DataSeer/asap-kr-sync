/**
 * Software Service - API client for software detection results
 *
 * @module services/software
 */

import api from './api'

export default {
  /**
   * Get software mentions for a submission
   * @param {string} submissionId
   * @returns {Promise<{ mentions: Array, meta: object|null }>}
   */
  async getMentions(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/software`)
    return response.data
  },

  /**
   * Trigger software detection (manual re-run)
   * @param {string} submissionId
   * @returns {Promise<object>}
   */
  async triggerDetection(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/software/detect`)
    return response.data
  }
}
