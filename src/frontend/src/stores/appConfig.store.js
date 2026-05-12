import { defineStore } from 'pinia'
import { ref } from 'vue'
import appConfigService from '@/services/appConfig.service'

export const useAppConfigStore = defineStore('appConfig', () => {
  // State
  const configs = ref([])
  const pagination = ref({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  })
  const loading = ref(false)
  const error = ref(null)

  // Actions
  async function fetchConfigs(params = {}) {
    loading.value = true
    error.value = null

    try {
      const response = await appConfigService.list(params)
      configs.value = response.configs
      pagination.value = response.pagination
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch configs'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function getConfig(key) {
    loading.value = true
    error.value = null

    try {
      const response = await appConfigService.getByKey(key)
      return response.config
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch config'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function saveConfig(data) {
    loading.value = true
    error.value = null

    try {
      const response = await appConfigService.upsert(data)

      // Update in list
      const index = configs.value.findIndex(c => c.key === data.key)
      if (index !== -1) {
        configs.value[index] = response.config
      } else {
        configs.value.push(response.config)
        // Sort by category then key
        configs.value.sort((a, b) => {
          if (a.category !== b.category) return a.category.localeCompare(b.category)
          return a.key.localeCompare(b.key)
        })
      }

      return response.config
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to save config'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function deleteConfig(key) {
    loading.value = true
    error.value = null

    try {
      await appConfigService.delete(key)

      // Remove from list
      const index = configs.value.findIndex(c => c.key === key)
      if (index !== -1) {
        configs.value.splice(index, 1)
      }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete config'
      throw err
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    configs,
    pagination,
    loading,
    error,
    // Actions
    fetchConfigs,
    getConfig,
    saveConfig,
    deleteConfig
  }
})
