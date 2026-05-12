/**
 * Markdown Convert Service
 * API calls for PDF-to-Markdown conversion.
 */

import api from './api'

export default {
  async triggerConvert(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/markdown/convert`)
    return data
  }
}
