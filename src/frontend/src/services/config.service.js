/**
 * Config Service - API client for application configuration
 *
 * @module services/config
 */

import api from './api'

/** Cached: the pipeline shape cannot change without a redeploy. */
let _pipeline = null
/** Same: where the code lives cannot change without a redeploy. */
let _source = null

export default {
  /**
   * The processing pipeline as a graph — steps, dependencies, stages.
   *
   * Static per deployment, so it is fetched once and cached here rather than
   * per component. Mirroring it in the client is what this replaces: two
   * hand-written copies had already drifted from the table that runs.
   */
  /** Repo and branch this deployment runs, for linking results to their prompts. */
  async getSource() {
    if (!_source) _source = (await api.get('/config/source')).data
    return _source
  },

  async getPipeline() {
    if (!_pipeline) _pipeline = (await api.get('/config/pipeline')).data
    return _pipeline
  },

  /**
   * The named DETECTION configurations a submission can be analysed with.
   *
   * Not `getPipeline()` above, which is the twelve-step job graph. The server
   * withholds admin-only arms from anyone who cannot choose them, so whatever
   * comes back is safe to offer.
   *
   * @returns {Promise<{pipelines: Array, defaultPipelineId: string}>}
   */
  async getDetectionPipelines() {
    return (await api.get('/config/detection-pipelines')).data
  },

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
