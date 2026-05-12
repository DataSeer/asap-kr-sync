/**
 * Datasets Service - API client for datasets detection results
 *
 * @module services/datasets
 */

import api from './api'

export default {
  /**
   * Get dataset mentions for a submission
   * @param {string} submissionId
   * @returns {Promise<{ mentions: Array, meta: object|null }>}
   */
  async getMentions(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/datasets`)
    return response.data
  },

  /**
   * Trigger datasets detection (manual re-run)
   * @param {string} submissionId
   * @returns {Promise<object>}
   */
  async triggerDetection(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/datasets/detect`)
    return response.data
  }
}
