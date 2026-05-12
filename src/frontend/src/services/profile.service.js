/**
 * Profile Service
 */

import api from './api'

export default {
  /**
   * Get current user's profile
   */
  async getProfile() {
    const response = await api.get('/profile')
    return response.data
  },

  /**
   * Update current user's profile
   * @param {object} data - { name?, currentPassword?, newPassword? }
   */
  async updateProfile(data) {
    const response = await api.patch('/profile', data)
    return response.data
  }
}
