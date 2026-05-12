/**
 * Enrichment List Service
 * Consolidated API calls for managing all curated enrichment reference lists
 * (software, materials, datasets, protocols) via a single parameterised endpoint.
 */

import api from './api'

export default {
  /**
   * Fetch a paginated list of entries for a given category.
   * @param {string} category - e.g. 'software', 'materials', 'datasets', 'protocols'
   * @param {object} params - query params (page, limit, search, resourceType, …)
   */
  async list(category, params = {}) {
    const { data } = await api.get(`/enrichment-list/${category}`, { params })
    return data
  },

  /**
   * Fetch a single entry by id.
   * @param {string} category
   * @param {string|number} id
   */
  async getById(category, id) {
    const { data } = await api.get(`/enrichment-list/${category}/${id}`)
    return data
  },

  /**
   * Create a new entry.
   * @param {string} category
   * @param {object} entry
   */
  async create(category, entry) {
    const { data } = await api.post(`/enrichment-list/${category}`, entry)
    return data
  },

  /**
   * Update an existing entry.
   * @param {string} category
   * @param {string|number} id
   * @param {object} entry
   */
  async update(category, id, entry) {
    const { data } = await api.patch(`/enrichment-list/${category}/${id}`, entry)
    return data
  },

  /**
   * Delete an entry.
   * @param {string} category
   * @param {string|number} id
   */
  async remove(category, id) {
    const { data } = await api.delete(`/enrichment-list/${category}/${id}`)
    return data
  },

  /**
   * Bulk-import entries from a parsed CSV array.
   * @param {string} category
   * @param {object[]} entries
   * @param {'append'|'replace'} mode
   * @param {string|null} resourceType - used by materials replace mode to scope deletion
   */
  async importEntries(category, entries, mode = 'append', resourceType = null) {
    const { data } = await api.post(`/enrichment-list/${category}/import`, { entries, mode, resourceType })
    return data
  },

  /**
   * Download entries as a CSV blob.
   * @param {string} category
   * @param {object} params - optional filters (resourceType, search, …)
   */
  async exportCsv(category, params = {}) {
    const { data } = await api.get(`/enrichment-list/${category}/export`, { params, responseType: 'blob' })
    return data
  },

  /**
   * Fetch per-resourceType entry counts (used for materials tabs).
   * @param {string} category
   */
  async getCounts(category) {
    const { data } = await api.get(`/enrichment-list/${category}/counts`)
    return data
  },

  /**
   * Cross-category list — drives the unified Enrichments admin page.
   * @param {object} params - { category?, search?, resourceType?, page?, limit? }
   */
  async listAll(params = {}) {
    const { data } = await api.get('/enrichment-list', { params })
    return data
  },

  /**
   * Per-category counts in a single round-trip:
   *   { software, materials, datasets, protocols, total }
   */
  async getAllCounts() {
    const { data } = await api.get('/enrichment-list/_counts')
    return data
  }
}
