/**
 * Identifier Detection Service
 * API calls for the identifier-scan module (known RRID/DOI/PID/URL/catalog
 * lookups against the curated enrichment list).
 */

import api from './api'

export default {
  async getMentions(submissionId) {
    const { data } = await api.get(`/submissions/${submissionId}/identifiers`)
    return data
  },

  async triggerDetection(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/identifiers/detect`)
    return data
  }
}
