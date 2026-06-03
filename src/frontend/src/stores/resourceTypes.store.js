import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import resourceTypesService from '@/services/resourceTypes.service'

export const useResourceTypesStore = defineStore('resourceTypes', () => {
  // State
  const resourceTypes = ref([])
  const resourceTypeNames = ref([])
  // Map of resource type name → type category (dataset, software, protocol, lab_material)
  const resourceTypeMap = ref({})
  const pagination = ref({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  })
  const loading = ref(false)
  const error = ref(null)

  // Getters
  const activeResourceTypes = computed(() =>
    resourceTypes.value.filter(rt => rt.active)
  )

  const resourceTypeByName = computed(() => (name) =>
    resourceTypes.value.find(rt => rt.name === name)
  )

  /**
   * Get the type category for a resource type name.
   * Returns 'dataset', 'software', 'protocol', or 'lab_material'.
   */
  function getTypeCategory(resourceTypeName) {
    return resourceTypeMap.value[resourceTypeName] || 'lab_material'
  }

  /**
   * Get the tab group key for a resource type name.
   * Maps type categories to UI tab keys.
   */
  function getTabGroup(resourceTypeName) {
    const category = getTypeCategory(resourceTypeName)
    const mapping = {
      dataset: 'Datasets',
      software: 'Software/code',
      protocol: 'Protocols',
      lab_material: 'Lab Materials'
    }
    return mapping[category] || 'Lab Materials'
  }

  /**
   * Get the sort order for a type category (for "All" tab default sort).
   */
  function getGroupSortOrder(resourceTypeName) {
    const category = getTypeCategory(resourceTypeName)
    const order = { dataset: 0, software: 1, protocol: 2, lab_material: 3 }
    return order[category] ?? 3
  }

  /**
   * Get the per-resource-type sort order (used to order rows WITHIN a tab —
   * e.g. Antibody before Bacterial strain). Derived from the position of the
   * name in `resourceTypeNames`, which the backend already returns ordered by
   * sort_order ASC. Unknown names sort last.
   */
  function getTypeSortOrder(resourceTypeName) {
    if (!resourceTypeName) return Number.MAX_SAFE_INTEGER
    const idx = resourceTypeNames.value.indexOf(resourceTypeName)
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
  }

  // Actions
  async function fetchResourceTypes(params = {}) {
    loading.value = true
    error.value = null

    try {
      const response = await resourceTypesService.list(params)
      resourceTypes.value = response.resourceTypes
      pagination.value = response.pagination
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch resource types'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchResourceTypeNames() {
    try {
      const response = await resourceTypesService.getNames()
      resourceTypeNames.value = response.names
      // Build name → type map from items
      if (response.items) {
        const map = {}
        for (const item of response.items) {
          map[item.name] = item.type
        }
        resourceTypeMap.value = map
      }
      return response.names
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch resource type names'
      throw err
    }
  }

  async function createResourceType(data) {
    loading.value = true
    error.value = null

    try {
      const response = await resourceTypesService.create(data)
      resourceTypes.value.push(response.resourceType)
      resourceTypes.value.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.name.localeCompare(b.name)
      })
      await fetchResourceTypeNames()
      return response.resourceType
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to create resource type'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function updateResourceType(id, data) {
    loading.value = true
    error.value = null

    try {
      const response = await resourceTypesService.update(id, data)

      const index = resourceTypes.value.findIndex(rt => rt.id === id)
      if (index !== -1) {
        resourceTypes.value[index] = response.resourceType
      }
      resourceTypes.value.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
        return a.name.localeCompare(b.name)
      })
      await fetchResourceTypeNames()

      return response.resourceType
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update resource type'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function deleteResourceType(id) {
    loading.value = true
    error.value = null

    try {
      const resourceType = resourceTypes.value.find(rt => rt.id === id)
      await resourceTypesService.delete(id)

      const index = resourceTypes.value.findIndex(rt => rt.id === id)
      if (index !== -1) {
        resourceTypes.value.splice(index, 1)
      }
      await fetchResourceTypeNames()
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete resource type'
      throw err
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    resourceTypes,
    resourceTypeNames,
    resourceTypeMap,
    pagination,
    loading,
    error,
    // Getters
    activeResourceTypes,
    resourceTypeByName,
    // Helpers
    getTypeCategory,
    getTabGroup,
    getGroupSortOrder,
    getTypeSortOrder,
    // Actions
    fetchResourceTypes,
    fetchResourceTypeNames,
    createResourceType,
    updateResourceType,
    deleteResourceType
  }
})
