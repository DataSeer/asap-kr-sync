/**
 * Config Service - API client for application configuration
 *
 * @module services/config
 */

import api from './api'

export default {
  /**
   * Get the enabled/disabled status of each external service
   * @returns {Promise<Object>} - { services: { [jobType]: { enabled, hasDemoData } } }
   */
  async getServiceStatus() {
    const response = await api.get('/config/services')
    return response.data
  },

  /**
   * Get the environment label and public auth flags (e.g. signupEnabled).
   * @returns {Promise<{environment: string, signupEnabled: boolean}>}
   */
  async getEnvironment() {
    const response = await api.get('/config/environment')
    return response.data
  }
}
