/**
 * PDF Service - API client for PDF upload and AI analysis operations
 *
 * @module services/pdf
 */

import api from './api'

export default {
  /**
   * Upload a PDF file for a submission
   * @param {string} submissionId - The submission ID
   * @param {File} file - The PDF file to upload
   * @returns {Promise<Object>} - Upload result
   */
  async upload(submissionId, file) {
    const formData = new FormData()
    formData.append('file', file)

    const response = await api.post(`/submissions/${submissionId}/pdf/upload`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 120000 // 2 minutes for file uploads
    })
    return response.data
  },

  /**
   * Get the current analysis status
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - Analysis status (pending, running, completed, failed)
   */
  async getAnalysisStatus(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/pdf/analysis`)
    return response.data
  },

  /**
   * Get AI findings/suggestions from PDF analysis
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - Findings with suggested changes
   */
  async getFindings(submissionId) {
    const response = await api.get(`/submissions/${submissionId}/pdf/findings`)
    return response.data
  },

  /**
   * Trigger AI analysis of the uploaded PDF
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - Analysis initiation response
   */
  async triggerAnalysis(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/pdf/analyze`)
    return response.data
  },

  /**
   * Extract Data Availability Statement from uploaded PDF
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - { extracted: boolean, das: string|null }
   */
  async extractDAS(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/pdf/extract-das`)
    return response.data
  }
}
