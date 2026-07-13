/**
 * DAS Suggestions Service
 *
 * Reads the LM check of the Data/Code Availability Statement and re-triggers it.
 */

import api from './api'

export default {
  /**
   * Get the latest DAS-suggestions job status + suggestions.
   * @param {string} submissionId
   * @returns {Promise<{ status: string, suggestions: object[], meta: object|null }>}
   */
  async get(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/das-suggestions`)
    return response.data
  },

  /**
   * Re-run the DAS check (e.g. after the DAS text was edited).
   * @param {string} submissionId
   */
  async regenerate(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/das-suggestions/regenerate`)
    return response.data
  }
}
