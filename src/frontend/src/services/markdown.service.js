/**
 * Markdown Convert Service
 * API calls for PDF-to-Markdown conversion.
 */

import api from './api'

export default {
  /** The converted text of the manuscript, as text rather than a file link. */
  /**
   * The converted text. `fileId` asks for the version a particular run read
   * rather than the newest — the page shows a run, not the submission's
   * current state.
   */
  async getContent(submissionId, fileId = null) {
    const { data } = await api.get(`/submissions/${submissionId}/markdown`, {
      params: fileId ? { fileId } : {}
    })
    return data
  },

  async triggerConvert(submissionId) {
    const { data } = await api.post(`/submissions/${submissionId}/markdown/convert`)
    return data
  }
}
