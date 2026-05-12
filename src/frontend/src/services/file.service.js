import api from './api'

export default {
  async download(submissionId, fileId) {
    const response = await api.get(`/submissions/${submissionId}/files/${fileId}/download`)
    return response.data
  }
}
