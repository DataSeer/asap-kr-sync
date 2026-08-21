/**
 * Markdown Convert Service
 * API calls for PDF-to-Markdown conversion.
 */

import api from './api'

export default {
  /** The converted text of the manuscript, as text rather than a file link. */
  async getContent(submissionId) {
    const { data } = await api.get(`/submissions/${submissionId}/markdown`)
    return data
  },

  async triggerConvert(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/markdown/convert`)
    return data
  }
}
