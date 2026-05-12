/**
 * Demos Service
 * Lists demo manuscripts available on the server (driven by what's on disk
 * in src/frontend/public/demo-files/ + matching demo-findings/*-demo.json).
 */

import api from './api'

export default {
  /**
   * Fetch the list of available demos.
   * @returns {Promise<Array<{id: string, name: string, description: string, pdf: string, krt: string|null}>>}
   */
  async list() {
    const { data } = await api.get('/demos')
    return data.demos || []
  }
}
