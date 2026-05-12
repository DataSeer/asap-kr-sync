import api from './api'

export default {
  async generate(submissionId, type = 'excel') {
    const response = await api.post(`/submissions/${submissionId}/reports/generate`, {
      type
    })
    return response.data
  },

  async list(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/reports`)
    return response.data
  },

  async getById(submissionId, reportId) {
    const response = await api.get(`/submissions/${submissionId}/reports/${reportId}`)
    return response.data
  },

  async download(submissionId, reportId) {
    const response = await api.get(`/submissions/${submissionId}/reports/${reportId}/download`)
    return response.data
  }
}
