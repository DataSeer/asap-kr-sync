/**
 * Job Service - API client for background job status
 *
 * All endpoints support an optional `round` parameter.
 * When omitted, the backend defaults to the submission's current round.
 */

import api from './api'

export default {
  /**
   * Get all background jobs for a submission
   * @param {string} submissionId
   * @param {number} [round] - Optional round number (defaults to current round)
   * @returns {Promise<Object>} - { round, jobs: [...] }
   */
  async getJobs(submissionId, round = null) {
    const params = round ? { round } : {}
    const response = await api.get(`/submissions/${submissionId}/jobs`, { params })
    return response.data
  },

  /**
   * Run (or re-run) all background processes for a submission
   * @param {string} submissionId
   * @returns {Promise<Object>}
   */
  async runAllProcesses(submissionId) {
    const response = await api.post(`/submissions/${submissionId}/processes/run`)
    return response.data
  },

  /**
   * Manually advance a pending_input job to queued
   * @param {string} submissionId
   * @param {string} jobType
   * @param {number} [round]
   * @returns {Promise<Object>}
   */
  async advanceJob(submissionId, jobType, round = null) {
    const params = round ? { round } : {}
    // Send an empty object (not null): the backend's strict JSON body parser
    // rejects a literal `null` body. This endpoint carries no payload — the
    // round travels as a query param.
    const response = await api.post(`/submissions/${submissionId}/jobs/${jobType}/advance`, {}, { params })
    return response.data
  },

  /**
   * Get a presigned download URL for a job's raw response file
   * @param {string} submissionId
   * @param {string} jobType
   * @param {string} responseName
   * @param {number} [round]
   * @returns {Promise<Object>} - { url, name, s3Key, round }
   */
  async getJobResponseUrl(submissionId, jobType, responseName, round = null) {
    const params = round ? { round } : {}
    const response = await api.get(`/submissions/${submissionId}/jobs/${jobType}/responses/${responseName}`, { params })
    return response.data
  }
}
