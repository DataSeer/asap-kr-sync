/**
 * KRT Grounding Service
 * API calls for the reconciliation between the author's KRT and what detection
 * found in the manuscript (per author row: confirmed / incomplete / not_detected).
 */

import api from './api'

export default {
  async getGrounding(submissionId) {
    const { data } = await api.get(`/submissions/${submissionId}/grounding`)
    return data
  },

  async triggerGrounding(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/grounding/regenerate`)
    return data
  }
}
