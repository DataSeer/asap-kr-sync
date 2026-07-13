<script setup>
import { ref, computed, onMounted } from 'vue'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import { useNotificationStore } from '@/stores/notification.store'
import resourceTypesService from '@/services/resourceTypes.service'
import SearchInput from '@/components/common/SearchInput.vue'

const resourceTypesStore = useResourceTypesStore()
const notificationStore = useNotificationStore()

const RESOURCE_TYPE_CATEGORIES = [
  { value: 'dataset', label: 'Dataset' },
  { value: 'software', label: 'Software/code' },
  { value: 'protocol', label: 'Protocol' },
  { value: 'lab_material', label: 'Lab Material' }
]

const loading = ref(true)
const search = ref('')

const filteredResourceTypes = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return resourceTypesStore.resourceTypes
  return resourceTypesStore.resourceTypes.filter(rt =>
    (rt.name || '').toLowerCase().includes(q) ||
    (rt.type || '').toLowerCase().includes(q) ||
    (rt.description || '').toLowerCase().includes(q)
  )
})

const showEditModal = ref(false)
const showCreateModal = ref(false)
const editingResourceType = ref(null)
const saving = ref(false)
const importing = ref(false)
const fileInput = ref(null)
const showImportModal = ref(false)
const importMode = ref('append')
const importPreview = ref([])

const editForm = ref({
  name: '',
  type: 'lab_material',
  description: '',
  sortOrder: 0,
  active: true
})

const createForm = ref({
  name: '',
  type: 'lab_material',
  description: '',
  sortOrder: 0
})

onMounted(async () => {
  await fetchResourceTypes()
})

async function fetchResourceTypes() {
  loading.value = true
  try {
    await resourceTypesStore.fetchResourceTypes({ limit: 100 })
  } catch (error) {
    notificationStore.error('Failed to load resource types')
  } finally {
    loading.value = false
  }
}

function formatDate(date) {
  return new Date(date).toLocaleDateString()
}

function getCategoryLabel(type) {
  return RESOURCE_TYPE_CATEGORIES.find(c => c.value === type)?.label || type
}

function getCategoryBadgeClass(type) {
  const classes = {
    dataset: 'bg-blue-100 text-blue-700',
    software: 'bg-green-100 text-green-700',
    protocol: 'bg-purple-100 text-purple-700',
    lab_material: 'bg-amber-100 text-amber-700'
  }
  return classes[type] || 'bg-gray-100 text-gray-700'
}

function openEditModal(resourceType) {
  editingResourceType.value = resourceType
  editForm.value = {
    name: resourceType.name,
    type: resourceType.type || 'lab_material',
    description: resourceType.description || '',
    sortOrder: resourceType.sortOrder || 0,
    active: resourceType.active
  }
  showEditModal.value = true
}

function closeEditModal() {
  showEditModal.value = false
  editingResourceType.value = null
  editForm.value = { name: '', type: 'lab_material', description: '', sortOrder: 0, active: true }
}

async function handleSaveResourceType() {
  if (!editingResourceType.value) return
  saving.value = true
  try {
    await resourceTypesStore.updateResourceType(editingResourceType.value.id, {
      name: editForm.value.name,
      type: editForm.value.type,
      description: editForm.value.description || null,
      sortOrder: editForm.value.sortOrder,
      active: editForm.value.active
    })
    notificationStore.success('Resource type updated successfully')
    closeEditModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update resource type')
  } finally {
    saving.value = false
  }
}

async function handleDeleteResourceType(resourceType) {
  if (!confirm(`Are you sure you want to delete "${resourceType.name}"?`)) return
  try {
    await resourceTypesStore.deleteResourceType(resourceType.id)
    notificationStore.success('Resource type deleted successfully')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete resource type')
  }
}

function openCreateModal() {
  createForm.value = {
    name: '',
    type: 'lab_material',
    description: '',
    sortOrder: resourceTypesStore.resourceTypes.length
  }
  showCreateModal.value = true
}

function closeCreateModal() {
  showCreateModal.value = false
  createForm.value = { name: '', type: 'lab_material', description: '', sortOrder: 0 }
}

async function handleCreateResourceType() {
  saving.value = true
  try {
    await resourceTypesStore.createResourceType({
      name: createForm.value.name,
      type: createForm.value.type,
      description: createForm.value.description || null,
      sortOrder: createForm.value.sortOrder
    })
    notificationStore.success('Resource type created successfully')
    closeCreateModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create resource type')
  } finally {
    saving.value = false
  }
}

async function handleExport() {
  try {
    const blob = await resourceTypesService.exportCsv()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'resource-types.csv'
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    notificationStore.error('Failed to export')
  }
}

function triggerFileInput() {
  fileInput.value?.click()
}

function handleFileSelect(event) {
  const file = event.target.files[0]
  if (!file) return
  event.target.value = ''

  const reader = new FileReader()
  reader.onload = (e) => {
    const entries = parseCsv(e.target.result)
    if (entries.length === 0) {
      notificationStore.error('No valid entries found in CSV')
      return
    }
    importPreview.value = entries
    importMode.value = 'append'
    showImportModal.value = true
  }
  reader.readAsText(file)
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  const nameIdx = headers.findIndex(h => h === 'name')
  if (nameIdx === -1) return []

  const getIdx = (key) => headers.findIndex(h => h === key.toLowerCase())
  const typeIdx = getIdx('type')
  const descIdx = getIdx('description')
  const sortIdx = getIdx('sortorder')
  const activeIdx = getIdx('active')

  const get = (cols, idx) => idx >= 0 && idx < cols.length ? cols[idx].trim() : ''

  return lines.slice(1)
    .map(line => {
      const cols = parseCSVLine(line)
      const name = get(cols, nameIdx)
      if (!name) return null
      const activeVal = get(cols, activeIdx)
      return {
        name,
        type: get(cols, typeIdx) || 'lab_material',
        description: get(cols, descIdx) || undefined,
        sortOrder: parseInt(get(cols, sortIdx)) || 0,
        active: activeVal ? activeVal !== 'false' : true
      }
    })
    .filter(Boolean)
}

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        result.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }
  result.push(current)
  return result
}

function closeImportModal() {
  showImportModal.value = false
  importPreview.value = []
}

async function handleImport() {
  importing.value = true
  try {
    const result = await resourceTypesService.importEntries(importPreview.value, importMode.value)
    notificationStore.success(`Imported ${result.imported} resource types (${importMode.value})`)
    closeImportModal()
    await fetchResourceTypes()
    await resourceTypesStore.fetchResourceTypeNames()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to import')
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-6 flex-shrink-0">
      <h1 class="text-2xl font-bold text-gray-900">Resource Types</h1>
      <div class="flex items-center gap-2">
        <input ref="fileInput" type="file" accept=".csv" class="hidden" @change="handleFileSelect" />
        <button class="btn-secondary" @click="handleExport">Export CSV</button>
        <button class="btn-secondary" @click="triggerFileInput">Import CSV</button>
        <button class="btn-primary" @click="openCreateModal">Create Resource Type</button>
      </div>
    </div>

    <div v-if="loading" class="flex-1 flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <div v-else class="flex-1 min-h-0 flex flex-col">
      <p class="text-sm text-gray-500 mb-3 flex-shrink-0">{{ resourceTypesStore.resourceTypes.length }} resource types</p>

      <div class="card overflow-hidden flex-1 min-h-0 flex flex-col">
        <div class="table-scroll">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th colspan="6" class="px-4 py-3 bg-white border-b border-gray-200">
                  <SearchInput v-model="search" full-width placeholder="Search resource types…" />
                </th>
              </tr>
              <tr>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <tr v-for="resourceType in filteredResourceTypes" :key="resourceType.id" :class="{ 'bg-gray-50 opacity-60': !resourceType.active }">
                <td class="px-4 py-3 whitespace-nowrap text-gray-500">
                  {{ resourceType.sortOrder }}
                </td>
                <td class="px-4 py-3 whitespace-nowrap">
                  <div class="font-medium text-gray-900">{{ resourceType.name }}</div>
                </td>
                <td class="px-4 py-3 whitespace-nowrap">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" :class="getCategoryBadgeClass(resourceType.type)">
                    {{ getCategoryLabel(resourceType.type) }}
                  </span>
                </td>
                <td class="px-4 py-3 text-gray-500 max-w-xs truncate">
                  {{ resourceType.description || '-' }}
                </td>
                <td class="px-4 py-3 whitespace-nowrap">
                  <span :class="resourceType.active ? 'badge-success' : 'badge-gray'">
                    {{ resourceType.active ? 'Active' : 'Inactive' }}
                  </span>
                </td>
                <td class="px-4 py-3 whitespace-nowrap text-right">
                  <button class="text-primary-600 hover:text-primary-800 mr-3" @click="openEditModal(resourceType)">Edit</button>
                  <button class="text-red-600 hover:text-red-800" @click="handleDeleteResourceType(resourceType)">Delete</button>
                </td>
              </tr>
              <tr v-if="filteredResourceTypes.length === 0">
                <td colspan="6" class="px-4 py-8 text-center text-gray-500">
                  {{ search ? 'No resource types match your search.' : 'No resource types found. Create one to get started.' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Import Modal -->
    <div v-if="showImportModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeImportModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Import CSV</h2>
          <p class="text-sm text-gray-600 mb-3">{{ importPreview.length }} entries found in file.</p>
          <div class="mb-4">
            <label class="label mb-1">Import mode</label>
            <div class="flex items-center gap-4">
              <label class="flex items-center">
                <input v-model="importMode" type="radio" value="append" class="h-4 w-4 text-primary-600 border-gray-300" />
                <span class="ml-2 text-sm text-gray-700">Append (add to existing)</span>
              </label>
              <label class="flex items-center">
                <input v-model="importMode" type="radio" value="replace" class="h-4 w-4 text-primary-600 border-gray-300" />
                <span class="ml-2 text-sm text-red-600">Replace (delete all, then import)</span>
              </label>
            </div>
          </div>
          <div class="border rounded max-h-64 overflow-auto mb-4">
            <table class="min-w-full divide-y divide-gray-200 text-sm">
              <thead class="bg-gray-50 sticky top-0">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">#</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Name</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Type</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Order</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Active</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200">
                <tr v-for="(entry, i) in importPreview.slice(0, 50)" :key="i">
                  <td class="px-3 py-1 text-gray-400">{{ i + 1 }}</td>
                  <td class="px-3 py-1 text-gray-900">{{ entry.name }}</td>
                  <td class="px-3 py-1 text-gray-500">{{ entry.type }}</td>
                  <td class="px-3 py-1 text-gray-500">{{ entry.sortOrder }}</td>
                  <td class="px-3 py-1">
                    <span v-if="entry.active !== false" class="text-green-600">Yes</span>
                    <span v-else class="text-gray-400">No</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="importPreview.length > 50" class="px-3 py-2 text-xs text-gray-400 bg-gray-50">... and {{ importPreview.length - 50 }} more entries</p>
          </div>
          <div v-if="importMode === 'replace'" class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">This will delete all existing resource types before importing.</div>
          <div class="flex justify-end space-x-3">
            <button type="button" class="btn-secondary" @click="closeImportModal">Cancel</button>
            <button :disabled="importing" class="btn-primary" @click="handleImport">{{ importing ? 'Importing...' : `Import ${importPreview.length} entries` }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit Modal -->
    <div v-if="showEditModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeEditModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Edit Resource Type</h2>
          <form class="space-y-4" @submit.prevent="handleSaveResourceType">
            <div>
              <label class="label">Name</label>
              <input v-model="editForm.name" type="text" class="input" required maxlength="100" />
            </div>
            <div>
              <label class="label">Type</label>
              <select v-model="editForm.type" class="input">
                <option v-for="cat in RESOURCE_TYPE_CATEGORIES" :key="cat.value" :value="cat.value">{{ cat.label }}</option>
              </select>
              <p class="mt-1 text-xs text-gray-500">Groups this resource type in the Key Resources Table editor and suggestion tabs</p>
            </div>
            <div>
              <label class="label">Description (optional)</label>
              <textarea v-model="editForm.description" class="input" rows="2" placeholder="Description of this resource type"></textarea>
            </div>
            <div>
              <label class="label">Sort Order</label>
              <input v-model.number="editForm.sortOrder" type="number" class="input" min="0" />
              <p class="mt-1 text-xs text-gray-500">Lower numbers appear first in lists</p>
            </div>
            <div>
              <label class="flex items-center">
                <input v-model="editForm.active" type="checkbox" class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500" />
                <span class="ml-2 text-sm text-gray-700">Active</span>
              </label>
              <p class="mt-1 text-xs text-gray-500">Inactive types won't appear in selection lists</p>
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeEditModal">Cancel</button>
              <button type="submit" :disabled="saving" class="btn-primary">{{ saving ? 'Saving...' : 'Save' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <div v-if="showCreateModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeCreateModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Create Resource Type</h2>
          <form class="space-y-4" @submit.prevent="handleCreateResourceType">
            <div>
              <label class="label">Name</label>
              <input v-model="createForm.name" type="text" class="input" required maxlength="100" placeholder="e.g., Antibody" />
            </div>
            <div>
              <label class="label">Type</label>
              <select v-model="createForm.type" class="input">
                <option v-for="cat in RESOURCE_TYPE_CATEGORIES" :key="cat.value" :value="cat.value">{{ cat.label }}</option>
              </select>
              <p class="mt-1 text-xs text-gray-500">Groups this resource type in the Key Resources Table editor and suggestion tabs</p>
            </div>
            <div>
              <label class="label">Description (optional)</label>
              <textarea v-model="createForm.description" class="input" rows="2" placeholder="Description of this resource type"></textarea>
            </div>
            <div>
              <label class="label">Sort Order</label>
              <input v-model.number="createForm.sortOrder" type="number" class="input" min="0" />
              <p class="mt-1 text-xs text-gray-500">Lower numbers appear first in lists</p>
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeCreateModal">Cancel</button>
              <button type="submit" :disabled="saving" class="btn-primary">{{ saving ? 'Creating...' : 'Create' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
