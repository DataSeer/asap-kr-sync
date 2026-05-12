/**
 * Protocols Detection Service
 * API calls for protocols mentions.
 */

import api from './api'

export default {
  async getMentions(submissionId) {
    const { data } = await api.get(`/submissions/${submissionId}/protocols`)
    return data
  },

  async triggerDetection(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/protocols/detect`)
    return data
  }
}
