/**
 * Job Administration Service
 * Cross-submission view of the processing queue, plus cleanup actions.
 * Admin-only on the server.
 */

import api from './api'

export default {
  async getMeta() {
    const { data } = await api.get('/admin/jobs/meta')
    return data
  },

  async list(params = {}) {
    const { data } = await api.get('/admin/jobs', { params })
    return data
  },

  async deleteJob(id, { force = false } = {}) {
    const { data } = await api.delete(`/admin/jobs/${id}`, { params: force ? { force: 'true' } : {} })
    return data
  },

  async bulkDelete(ids, { force = false } = {}) {
    const { data } = await api.post('/admin/jobs/bulk-delete', { ids, force })
    return data
  },

  async cleanupStale(staleReason) {
    const { data } = await api.post('/admin/jobs/cleanup', { staleReason })
    return data
  },

  async listOrphanedQueue() {
    const { data } = await api.get('/admin/jobs/orphaned-queue')
    return data
  },

  async purgeOrphanedQueue() {
    const { data } = await api.post('/admin/jobs/purge-orphaned-queue')
    return data
  },

  async cancelJob(id) {
    const { data } = await api.post(`/admin/jobs/${id}/cancel`)
    return data
  }
}
