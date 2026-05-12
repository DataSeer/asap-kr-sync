/**
 * Materials Detection Service
 * API calls for materials mentions.
 */

import api from './api'

export default {
  async getMentions(submissionId) {
    const { data } = await api.get(`/submissions/${submissionId}/materials`)
    return data
  },

  async triggerDetection(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/materials/detect`)
    return data
  }
}
