<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import { useAppConfigStore } from '@/stores/appConfig.store'
import { useNotificationStore } from '@/stores/notification.store'
import resourceTypesService from '@/services/resourceTypes.service'

const route = useRoute()
const router = useRouter()
const resourceTypesStore = useResourceTypesStore()
const appConfigStore = useAppConfigStore()
const notificationStore = useNotificationStore()

const activeTab = ref(route.query.tab || 'resource-types')
const loading = ref(true)
const saving = ref(false)

watch(activeTab, (val) => {
  router.replace({ query: { ...route.query, tab: val } })
})

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([
      resourceTypesStore.fetchResourceTypes({ limit: 100 }),
      appConfigStore.fetchConfigs({ limit: 100 })
    ])
  } catch {
    notificationStore.error('Failed to load configuration')
  } finally {
    loading.value = false
  }
})

// ─── Resource Types ───

const showRTEditModal = ref(false)
const showRTCreateModal = ref(false)
const editingResourceType = ref(null)
const rtImporting = ref(false)
const rtFileInput = ref(null)
const showRTImportModal = ref(false)
const rtImportMode = ref('append')
const rtImportPreview = ref([])

const rtEditForm = ref({ name: '', description: '', sortOrder: 0, active: true })
const rtCreateForm = ref({ name: '', description: '', sortOrder: 0 })

function openRTCreateModal() {
  rtCreateForm.value = { name: '', description: '', sortOrder: resourceTypesStore.resourceTypes.length }
  showRTCreateModal.value = true
}

function closeRTCreateModal() { showRTCreateModal.value = false }

async function handleRTCreate() {
  saving.value = true
  try {
    await resourceTypesStore.createResourceType(rtCreateForm.value)
    notificationStore.success('Resource type created')
    closeRTCreateModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create')
  } finally {
    saving.value = false
  }
}

function openRTEditModal(rt) {
  editingResourceType.value = rt
  rtEditForm.value = {
    name: rt.name, description: rt.description || '',
    sortOrder: rt.sortOrder || 0, active: rt.active
  }
  showRTEditModal.value = true
}

function closeRTEditModal() { showRTEditModal.value = false; editingResourceType.value = null }

async function handleRTSave() {
  if (!editingResourceType.value) return
  saving.value = true
  try {
    await resourceTypesStore.updateResourceType(editingResourceType.value.id, rtEditForm.value)
    notificationStore.success('Resource type updated')
    closeRTEditModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update')
  } finally {
    saving.value = false
  }
}

async function handleRTDelete(rt) {
  if (!confirm(`Delete "${rt.name}"?`)) return
  try {
    await resourceTypesStore.deleteResourceType(rt.id)
    notificationStore.success('Resource type deleted')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete')
  }
}

async function handleRTExport() {
  try {
    const blob = await resourceTypesService.exportCsv()
    downloadBlob(blob, 'resource-types.csv')
  } catch { notificationStore.error('Failed to export') }
}

function triggerRTFileInput() { rtFileInput.value?.click() }

function handleRTFileSelect(event) {
  const file = event.target.files[0]
  if (!file) return
  event.target.value = ''
  const reader = new FileReader()
  reader.onload = (e) => {
    const entries = parseRTCsv(e.target.result)
    if (entries.length === 0) { notificationStore.error('No valid entries found'); return }
    rtImportPreview.value = entries
    rtImportMode.value = 'append'
    showRTImportModal.value = true
  }
  reader.readAsText(file)
}

function parseRTCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  const nameIdx = headers.findIndex(h => h === 'name')
  if (nameIdx === -1) return []
  const descIdx = headers.findIndex(h => h === 'description')
  const sortIdx = headers.findIndex(h => h === 'sortorder')
  const activeIdx = headers.findIndex(h => h === 'active')
  const get = (cols, idx) => idx >= 0 && idx < cols.length ? cols[idx].trim() : ''
  return lines.slice(1).map(line => {
    const cols = parseCSVLine(line)
    const name = get(cols, nameIdx)
    if (!name) return null
    const activeVal = get(cols, activeIdx)
    return { name, description: get(cols, descIdx) || undefined, sortOrder: parseInt(get(cols, sortIdx)) || 0, active: activeVal ? activeVal !== 'false' : true }
  }).filter(Boolean)
}

function closeRTImportModal() { showRTImportModal.value = false; rtImportPreview.value = [] }

async function handleRTImport() {
  rtImporting.value = true
  try {
    const result = await resourceTypesService.importEntries(rtImportPreview.value, rtImportMode.value)
    notificationStore.success(`Imported ${result.imported} resource types`)
    closeRTImportModal()
    await resourceTypesStore.fetchResourceTypes({ limit: 100 })
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to import')
  } finally {
    rtImporting.value = false
  }
}

// ─── Validation Rules (App Config) ───

const showConfigEditModal = ref(false)
const editingConfig = ref(null)
const jsonError = ref('')
const configEditForm = ref({ key: '', value: '', description: '', category: 'general' })

const configsByCategory = computed(() => {
  const grouped = {}
  for (const config of appConfigStore.configs) {
    const category = config.category || 'general'
    if (!grouped[category]) grouped[category] = []
    grouped[category].push(config)
  }
  return grouped
})

function formatDate(date) { return new Date(date).toLocaleDateString() }

function formatValue(value) {
  if (typeof value === 'object') return JSON.stringify(value, null, 2).substring(0, 100) + '...'
  return String(value).substring(0, 100)
}

function isComplexValue(value) { return typeof value === 'object' && Object.keys(value).length > 3 }

function openConfigEditModal(config) {
  editingConfig.value = config
  configEditForm.value = {
    key: config.key, value: JSON.stringify(config.value, null, 2),
    description: config.description || '', category: config.category || 'general'
  }
  jsonError.value = ''
  showConfigEditModal.value = true
}

function closeConfigEditModal() { showConfigEditModal.value = false; editingConfig.value = null; jsonError.value = '' }

function validateJson() {
  try { JSON.parse(configEditForm.value.value); jsonError.value = ''; return true }
  catch (e) { jsonError.value = 'Invalid JSON: ' + e.message; return false }
}

async function handleConfigSave() {
  if (!editingConfig.value || !validateJson()) return
  saving.value = true
  try {
    await appConfigStore.saveConfig({
      key: configEditForm.value.key, value: JSON.parse(configEditForm.value.value),
      description: configEditForm.value.description || null, category: configEditForm.value.category
    })
    notificationStore.success('Config updated')
    closeConfigEditModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update')
  } finally {
    saving.value = false
  }
}

async function handleConfigDelete(config) {
  if (!confirm(`Delete config "${config.key}"?`)) return
  try {
    await appConfigStore.deleteConfig(config.key)
    notificationStore.success('Config deleted')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete')
  }
}

// ─── Shared helpers ───

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') { inQuotes = false }
      else { current += ch }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { result.push(current); current = '' }
      else { current += ch }
    }
  }
  result.push(current)
  return result
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-6">KRT Configuration</h1>

    <!-- Tabs -->
    <div class="flex border-b border-gray-200 mb-6">
      <button
        class="tab-btn"
        :class="{ 'tab-active': activeTab === 'resource-types' }"
        @click="activeTab = 'resource-types'"
      >
        Resource Types
      </button>
      <button
        class="tab-btn"
        :class="{ 'tab-active': activeTab === 'validation-rules' }"
        @click="activeTab = 'validation-rules'"
      >
        Validation Rules
      </button>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <!-- ═══ Resource Types Tab ═══ -->
    <template v-else-if="activeTab === 'resource-types'">
      <div class="flex items-center justify-between mb-4">
        <p class="text-sm text-gray-500">{{ resourceTypesStore.resourceTypes.length }} resource types</p>
        <div class="flex items-center gap-2">
          <input ref="rtFileInput" type="file" accept=".csv" class="hidden" @change="handleRTFileSelect" />
          <button class="btn-secondary" @click="handleRTExport">Export CSV</button>
          <button class="btn-secondary" @click="triggerRTFileInput">Import CSV</button>
          <button class="btn-primary" @click="openRTCreateModal">Create Resource Type</button>
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="table-scroll">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <tr v-for="rt in resourceTypesStore.resourceTypes" :key="rt.id" :class="{ 'bg-gray-50 opacity-60': !rt.active }">
                <td class="px-6 py-4 whitespace-nowrap text-gray-500">{{ rt.sortOrder }}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                  <div class="font-medium text-gray-900">{{ rt.name }}</div>
                </td>
                <td class="px-6 py-4 text-gray-500 max-w-xs truncate">{{ rt.description || '-' }}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                  <span :class="rt.active ? 'badge-success' : 'badge-gray'">{{ rt.active ? 'Active' : 'Inactive' }}</span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right">
                  <button class="text-primary-600 hover:text-primary-800 mr-3" @click="openRTEditModal(rt)">Edit</button>
                  <button class="text-red-600 hover:text-red-800" @click="handleRTDelete(rt)">Delete</button>
                </td>
              </tr>
              <tr v-if="resourceTypesStore.resourceTypes.length === 0">
                <td colspan="5" class="px-6 py-8 text-center text-gray-500">No resource types found.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ═══ Validation Rules Tab ═══ -->
    <template v-else-if="activeTab === 'validation-rules'">
      <div v-for="(configs, category) in configsByCategory" :key="category" class="mb-8">
        <h2 class="text-lg font-semibold text-gray-800 mb-3 capitalize">{{ category }}</h2>
        <div class="card overflow-hidden">
          <div class="table-scroll">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Key</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Description</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Value Preview</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Updated</th>
                  <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr v-for="config in configs" :key="config.id">
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div class="font-medium text-gray-900 font-mono text-sm">{{ config.key }}</div>
                  </td>
                  <td class="px-6 py-4 text-gray-500 max-w-xs">{{ config.description || '-' }}</td>
                  <td class="px-6 py-4 text-gray-500">
                    <code v-if="isComplexValue(config.value)" class="text-xs bg-gray-100 px-2 py-1 rounded">{{ Object.keys(config.value).length }} keys</code>
                    <code v-else class="text-xs bg-gray-100 px-2 py-1 rounded break-all">{{ formatValue(config.value) }}</code>
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap text-gray-500">{{ formatDate(config.updated_at) }}</td>
                  <td class="px-6 py-4 whitespace-nowrap text-right">
                    <button class="text-primary-600 hover:text-primary-800 mr-3" @click="openConfigEditModal(config)">Edit</button>
                    <button class="text-red-600 hover:text-red-800" @click="handleConfigDelete(config)">Delete</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div v-if="Object.keys(configsByCategory).length === 0" class="card p-8 text-center text-gray-500">
        No configurations found.
      </div>
    </template>

    <!-- ═══ Modals ═══ -->

    <!-- RT Import Modal -->
    <div v-if="showRTImportModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeRTImportModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Import CSV</h2>
          <p class="text-sm text-gray-600 mb-3">{{ rtImportPreview.length }} entries found in file.</p>
          <div class="mb-4">
            <label class="label mb-1">Import mode</label>
            <div class="flex items-center gap-4">
              <label class="flex items-center">
                <input v-model="rtImportMode" type="radio" value="append" class="h-4 w-4 text-primary-600 border-gray-300" />
                <span class="ml-2 text-sm text-gray-700">Append</span>
              </label>
              <label class="flex items-center">
                <input v-model="rtImportMode" type="radio" value="replace" class="h-4 w-4 text-primary-600 border-gray-300" />
                <span class="ml-2 text-sm text-red-600">Replace all</span>
              </label>
            </div>
          </div>
          <div class="border rounded max-h-64 overflow-auto mb-4">
            <table class="min-w-full divide-y divide-gray-200 text-sm">
              <thead class="bg-gray-50 sticky top-0">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">#</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Name</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Description</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Order</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200">
                <tr v-for="(entry, i) in rtImportPreview.slice(0, 50)" :key="i">
                  <td class="px-3 py-1 text-gray-400">{{ i + 1 }}</td>
                  <td class="px-3 py-1 text-gray-900">{{ entry.name }}</td>
                  <td class="px-3 py-1 text-gray-500">{{ entry.description || '-' }}</td>
                  <td class="px-3 py-1 text-gray-500">{{ entry.sortOrder }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="rtImportPreview.length > 50" class="px-3 py-2 text-xs text-gray-400 bg-gray-50">... and {{ rtImportPreview.length - 50 }} more</p>
          </div>
          <div v-if="rtImportMode === 'replace'" class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            This will delete all existing resource types before importing.
          </div>
          <div class="flex justify-end space-x-3">
            <button class="btn-secondary" @click="closeRTImportModal">Cancel</button>
            <button :disabled="rtImporting" class="btn-primary" @click="handleRTImport">{{ rtImporting ? 'Importing...' : `Import ${rtImportPreview.length} entries` }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- RT Edit Modal -->
    <div v-if="showRTEditModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeRTEditModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Edit Resource Type</h2>
          <form class="space-y-4" @submit.prevent="handleRTSave">
            <div>
              <label class="label">Name</label>
              <input v-model="rtEditForm.name" type="text" class="input" required maxlength="100" />
            </div>
            <div>
              <label class="label">Description</label>
              <textarea v-model="rtEditForm.description" class="input" rows="2"></textarea>
            </div>
            <div>
              <label class="label">Sort Order</label>
              <input v-model.number="rtEditForm.sortOrder" type="number" class="input" min="0" />
            </div>
            <label class="flex items-center">
              <input v-model="rtEditForm.active" type="checkbox" class="h-4 w-4 text-primary-600 border-gray-300 rounded" />
              <span class="ml-2 text-sm text-gray-700">Active</span>
            </label>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeRTEditModal">Cancel</button>
              <button type="submit" :disabled="saving" class="btn-primary">{{ saving ? 'Saving...' : 'Save' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- RT Create Modal -->
    <div v-if="showRTCreateModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeRTCreateModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Create Resource Type</h2>
          <form class="space-y-4" @submit.prevent="handleRTCreate">
            <div>
              <label class="label">Name</label>
              <input v-model="rtCreateForm.name" type="text" class="input" required maxlength="100" placeholder="e.g., Antibodies" />
            </div>
            <div>
              <label class="label">Description</label>
              <textarea v-model="rtCreateForm.description" class="input" rows="2"></textarea>
            </div>
            <div>
              <label class="label">Sort Order</label>
              <input v-model.number="rtCreateForm.sortOrder" type="number" class="input" min="0" />
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeRTCreateModal">Cancel</button>
              <button type="submit" :disabled="saving" class="btn-primary">{{ saving ? 'Creating...' : 'Create' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- Config Edit Modal -->
    <div v-if="showConfigEditModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeConfigEditModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-2xl w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">
            Edit Config: <code class="bg-gray-100 px-2 py-1 rounded">{{ configEditForm.key }}</code>
          </h2>
          <form class="space-y-4" @submit.prevent="handleConfigSave">
            <div>
              <label class="label">Description</label>
              <input v-model="configEditForm.description" type="text" class="input" />
            </div>
            <div>
              <label class="label">Category</label>
              <input v-model="configEditForm.category" type="text" class="input" placeholder="e.g., general, krt, validation" />
            </div>
            <div>
              <label class="label">Value (JSON)</label>
              <textarea v-model="configEditForm.value" class="input font-mono text-sm" rows="12" @blur="validateJson"></textarea>
              <p v-if="jsonError" class="mt-1 text-sm text-red-600">{{ jsonError }}</p>
              <p v-else class="mt-1 text-xs text-gray-500">Enter a valid JSON value</p>
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeConfigEditModal">Cancel</button>
              <button type="submit" :disabled="saving || !!jsonError" class="btn-primary">{{ saving ? 'Saving...' : 'Save' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-scroll {
  max-height: 480px;
  overflow-y: auto;
}

.tab-btn {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #6b7280;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  transition: all 0.15s;
}

.tab-btn:hover {
  color: #374151;
}

.tab-active {
  color: #1d4ed8;
  border-bottom-color: #1d4ed8;
}
</style>
