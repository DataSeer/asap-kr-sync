<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import Papa from 'papaparse'
import { useNotificationStore } from '@/stores/notification.store'
import enrichmentListService from '@/services/enrichment-list.service'

// ---------------------------------------------------------------------------
// Category config
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { key: 'all',       label: 'All',       defaultResourceType: '' },
  { key: 'software',  label: 'Software',  defaultResourceType: 'Software/code' },
  { key: 'materials', label: 'Materials', defaultResourceType: 'Lab Material' },
  { key: 'datasets',  label: 'Datasets',  defaultResourceType: 'Dataset' },
  { key: 'protocols', label: 'Protocols', defaultResourceType: 'Protocol' }
]

const REAL_CATEGORIES = CATEGORIES.filter(c => c.key !== 'all')
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]))

const notificationStore = useNotificationStore()

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const selectedCategory = ref('all')

const loading = ref(true)
const entries = ref([])
const total = ref(0)
const counts = ref({ software: 0, materials: 0, datasets: 0, protocols: 0, total: 0 })
const page = ref(1)
const totalPages = ref(1)
const search = ref('')
const perPage = ref(25)

const saving = ref(false)
const importing = ref(false)
const fileInput = ref(null)
const showImportModal = ref(false)
const importMode = ref('append')
const importCategory = ref('software')
const importPreview = ref([])

const showEditModal = ref(false)
const showCreateModal = ref(false)
const editingEntry = ref(null)

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function emptyForm(category) {
  const cfg = CATEGORY_BY_KEY[category] || CATEGORY_BY_KEY.software
  return {
    category: category && category !== 'all' ? category : 'software',
    resourceType: cfg.defaultResourceType || '',
    resourceName: '',
    source: '',
    identifier: '',
    newReuse: cfg.defaultResourceType === 'Software/code' ? 'reuse' : '',
    additionalInformation: '',
    suggestedEntity: ''
  }
}

const editForm = ref(emptyForm('software'))
const createForm = ref(emptyForm('software'))

const isAllMode = computed(() => selectedCategory.value === 'all')

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

let searchTimeout = null
watch(search, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    page.value = 1
    fetchEntries()
  }, 300)
})

watch(selectedCategory, () => {
  page.value = 1
  fetchEntries()
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => initialise())

async function initialise() {
  await Promise.all([fetchEntries(), fetchCounts()])
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchEntries() {
  loading.value = true
  try {
    const params = { page: page.value, limit: perPage.value }
    if (!isAllMode.value) params.category = selectedCategory.value
    if (search.value.trim()) params.search = search.value.trim()
    const result = await enrichmentListService.listAll(params)
    entries.value = result.entries
    total.value = result.total
    totalPages.value = result.totalPages
  } catch {
    notificationStore.error('Failed to load enrichment entries')
  } finally {
    loading.value = false
  }
}

async function fetchCounts() {
  try {
    counts.value = await enrichmentListService.getAllCounts()
  } catch {
    // Non-critical — tab badges can stay at 0.
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function openCreateModal() {
  // Default to the active tab's category, falling back to software when "all"
  // is selected so the form has a concrete target.
  const target = isAllMode.value ? 'software' : selectedCategory.value
  createForm.value = emptyForm(target)
  showCreateModal.value = true
}

function closeCreateModal() {
  showCreateModal.value = false
}

async function handleCreate() {
  if (!createForm.value.resourceName.trim()) return
  const { category, ...payload } = createForm.value
  saving.value = true
  try {
    await enrichmentListService.create(category, payload)
    notificationStore.success('Entry created')
    closeCreateModal()
    await Promise.all([fetchEntries(), fetchCounts()])
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create entry')
  } finally {
    saving.value = false
  }
}

function openEditModal(entry) {
  editingEntry.value = entry
  const cfg = CATEGORY_BY_KEY[entry.category] || CATEGORY_BY_KEY.software
  editForm.value = {
    category: entry.category,
    resourceType: entry.resourceType || cfg.defaultResourceType || '',
    resourceName: entry.resourceName || '',
    source: entry.source || '',
    identifier: entry.identifier || '',
    newReuse: entry.newReuse || '',
    additionalInformation: entry.additionalInformation || '',
    suggestedEntity: entry.suggestedEntity || ''
  }
  showEditModal.value = true
}

function closeEditModal() {
  showEditModal.value = false
  editingEntry.value = null
}

async function handleSave() {
  if (!editingEntry.value) return
  const { category, ...payload } = editForm.value
  saving.value = true
  try {
    await enrichmentListService.update(category, editingEntry.value.id, payload)
    notificationStore.success('Entry updated')
    closeEditModal()
    await fetchEntries()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update entry')
  } finally {
    saving.value = false
  }
}

async function handleDelete(entry) {
  if (!confirm(`Delete "${entry.resourceName}"?`)) return
  try {
    await enrichmentListService.remove(entry.category, entry.id)
    notificationStore.success('Entry deleted')
    await Promise.all([fetchEntries(), fetchCounts()])
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete entry')
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function goToPage(p) {
  if (p < 1 || p > totalPages.value) return
  page.value = p
  fetchEntries()
}

// ---------------------------------------------------------------------------
// CSV import / export
// ---------------------------------------------------------------------------

function triggerFileInput() {
  fileInput.value?.click()
}

function handleFileSelect(event) {
  const file = event.target.files[0]
  if (!file) return
  event.target.value = ''

  const reader = new FileReader()
  reader.onload = (e) => {
    const parsed = parseCsv(e.target.result)
    if (parsed.length === 0) {
      notificationStore.error('No valid entries found in CSV')
      return
    }
    importPreview.value = parsed
    importMode.value = 'append'
    importCategory.value = isAllMode.value ? 'software' : selectedCategory.value
    showImportModal.value = true
  }
  reader.readAsText(file)
}

function parseCsv(text) {
  const { data } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim()
  })

  return data
    .filter(row => (row.resourceName || row.resourcename)?.trim())
    .map(row => ({
      resourceType: row.resourceType || row.resourcetype || '',
      resourceName: (row.resourceName || row.resourcename).trim(),
      source: row.source?.trim() || '',
      identifier: row.identifier?.trim() || '',
      newReuse: row.newReuse || row.newreuse || '',
      additionalInformation: row.additionalInformation || row.additionalinformation || '',
      suggestedEntity: row.suggestedEntity || row.suggestedentity || '',
      tokens: parseTokensCell(row.tokens)
    }))
}

/**
 * The import format encodes tokens as a JSON array string. Some rows may use
 * a pipe-separated fallback. Empty/invalid → empty array.
 */
function parseTokensCell(raw) {
  if (!raw) return []
  const trimmed = String(raw).trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      return Array.isArray(arr) ? arr.filter(Boolean).map(String) : []
    } catch {
      return []
    }
  }
  return trimmed.split('|').map(s => s.trim()).filter(Boolean)
}

function closeImportModal() {
  showImportModal.value = false
  importPreview.value = []
}

async function handleExport() {
  // When a specific category is active, export that one. In "All" mode we
  // export each category serially and bundle into separate downloads — the
  // existing endpoint is per-category, so a true union export would need
  // backend work. Concatenating 4 CSVs client-side is good enough.
  try {
    if (!isAllMode.value) {
      const blob = await enrichmentListService.exportCsv(selectedCategory.value)
      downloadBlob(blob, `enrichment-${selectedCategory.value}.csv`)
      return
    }
    for (const cat of REAL_CATEGORIES.map(c => c.key)) {
      const blob = await enrichmentListService.exportCsv(cat)
      downloadBlob(blob, `enrichment-${cat}.csv`)
    }
  } catch {
    notificationStore.error('Failed to export')
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function handleImport() {
  if (!importCategory.value) {
    notificationStore.error('Pick a target category before importing')
    return
  }
  importing.value = true
  try {
    const result = await enrichmentListService.importEntries(
      importCategory.value,
      importPreview.value,
      importMode.value
    )
    notificationStore.success(
      `Imported ${result.imported} entries into ${importCategory.value} (${importMode.value})`
    )
    closeImportModal()
    page.value = 1
    await Promise.all([fetchEntries(), fetchCounts()])
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to import entries')
  } finally {
    importing.value = false
  }
}

function categoryBadgeClass(cat) {
  switch (cat) {
    case 'software':  return 'bg-purple-100 text-purple-800'
    case 'materials': return 'bg-amber-100 text-amber-800'
    case 'datasets':  return 'bg-emerald-100 text-emerald-800'
    case 'protocols': return 'bg-sky-100 text-sky-800'
    default:          return 'bg-gray-100 text-gray-800'
  }
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-2xl font-bold text-gray-900">Enrichments</h1>
      <div class="flex items-center gap-2">
        <input ref="fileInput" type="file" accept=".csv" class="hidden" @change="handleFileSelect" />
        <button class="btn-secondary" @click="handleExport">Export CSV</button>
        <button class="btn-secondary" @click="triggerFileInput">Import CSV</button>
        <button class="btn-primary" @click="openCreateModal">Add Entry</button>
      </div>
    </div>

    <!-- Category tabs -->
    <div class="border-b border-gray-200 mb-4">
      <nav class="-mb-px flex space-x-2 overflow-x-auto" aria-label="Tabs">
        <button
          v-for="c in CATEGORIES"
          :key="c.key"
          class="whitespace-nowrap px-3 py-2 border-b-2 text-sm font-medium flex items-center gap-2 transition-colors"
          :class="selectedCategory === c.key
            ? 'border-primary-500 text-primary-600'
            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'"
          @click="selectedCategory = c.key"
        >
          {{ c.label }}
          <span
            class="px-2 py-0.5 rounded-full text-xs font-semibold"
            :class="selectedCategory === c.key ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-600'"
          >
            {{ c.key === 'all' ? counts.total : (counts[c.key] || 0) }}
          </span>
        </button>
      </nav>
    </div>

    <!-- Search -->
    <div class="mb-4">
      <input v-model="search" type="text" class="input max-w-md" placeholder="Search by name or identifier..." />
    </div>

    <!-- Summary + per-page -->
    <div class="flex items-center justify-between mb-3">
      <p class="text-sm text-gray-500">
        {{ total }} {{ total === 1 ? 'entry' : 'entries' }} in
        {{ isAllMode ? 'all categories' : selectedCategory }}
      </p>
      <div class="flex items-center gap-2">
        <label class="text-sm text-gray-500">Show</label>
        <select v-model="perPage" class="text-sm border border-gray-300 rounded px-2 py-1 text-gray-700" @change="page = 1; fetchEntries()">
          <option :value="10">10</option>
          <option :value="25">25</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
        </select>
        <span class="text-sm text-gray-500">per page</span>
      </div>
    </div>

    <!-- Loading spinner -->
    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <!-- Table -->
    <div v-else class="card overflow-hidden">
      <div class="table-scroll">
        <table class="min-w-full divide-y divide-gray-200">
          <thead class="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th v-if="isAllMode" class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Resource Name</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Resource Type</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Identifier</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">New/Reuse</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody class="bg-white divide-y divide-gray-200">
            <tr v-for="entry in entries" :key="entry.id">
              <td v-if="isAllMode" class="px-4 py-3">
                <span class="px-2 py-0.5 rounded-full text-xs font-medium" :class="categoryBadgeClass(entry.category)">
                  {{ entry.category }}
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="font-medium text-gray-900">{{ entry.resourceName }}</div>
                <div v-if="entry.suggestedEntity" class="text-xs text-gray-400">{{ entry.suggestedEntity }}</div>
              </td>
              <td class="px-4 py-3 text-sm text-gray-500">{{ entry.resourceType || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                <a v-if="entry.source && entry.source.startsWith('http')" :href="entry.source" target="_blank" rel="noopener" class="text-primary-600 hover:underline">{{ entry.source }}</a>
                <span v-else>{{ entry.source || '-' }}</span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-500">{{ entry.identifier || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-500">{{ entry.newReuse || '-' }}</td>
              <td class="px-4 py-3 whitespace-nowrap text-right">
                <button class="text-primary-600 hover:text-primary-800 mr-3" @click="openEditModal(entry)">Edit</button>
                <button class="text-red-600 hover:text-red-800" @click="handleDelete(entry)">Delete</button>
              </td>
            </tr>
            <tr v-if="entries.length === 0">
              <td :colspan="isAllMode ? 7 : 6" class="px-4 py-8 text-center text-gray-500">No entries found.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-center mt-4 space-x-2">
      <button :disabled="page === 1" class="px-3 py-1 text-sm rounded border" :class="page === 1 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100'" @click="goToPage(page - 1)">Previous</button>
      <span class="text-sm text-gray-600">Page {{ page }} of {{ totalPages }}</span>
      <button :disabled="page === totalPages" class="px-3 py-1 text-sm rounded border" :class="page === totalPages ? 'text-gray-300 cursor-not-allowed' : 'text-gray-700 hover:bg-gray-100'" @click="goToPage(page + 1)">Next</button>
    </div>

    <!-- Edit Modal -->
    <div v-if="showEditModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeEditModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">
            Edit Entry
            <span class="ml-2 px-2 py-0.5 rounded-full text-xs font-medium" :class="categoryBadgeClass(editForm.category)">
              {{ editForm.category }}
            </span>
          </h2>
          <form class="space-y-3" @submit.prevent="handleSave">
            <div>
              <label class="label">Resource Type</label>
              <input v-model="editForm.resourceType" type="text" class="input" />
            </div>
            <div>
              <label class="label">Resource Name</label>
              <input v-model="editForm.resourceName" type="text" class="input" required />
            </div>
            <div>
              <label class="label">Source</label>
              <input v-model="editForm.source" type="text" class="input" placeholder="URL or vendor" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">Identifier</label>
                <input v-model="editForm.identifier" type="text" class="input" placeholder="RRID, DOI, etc." />
              </div>
              <div>
                <label class="label">New/Reuse</label>
                <select v-model="editForm.newReuse" class="input">
                  <option value="">-</option>
                  <option value="new">new</option>
                  <option value="reuse">reuse</option>
                </select>
              </div>
            </div>
            <div>
              <label class="label">Additional Information</label>
              <textarea v-model="editForm.additionalInformation" rows="2" class="input"></textarea>
            </div>
            <div>
              <label class="label">Suggested Entity <span class="text-gray-400 text-xs font-normal">(for matching)</span></label>
              <input v-model="editForm.suggestedEntity" type="text" class="input" />
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeEditModal">Cancel</button>
              <button type="submit" :disabled="saving" class="btn-primary">{{ saving ? 'Saving...' : 'Save' }}</button>
            </div>
          </form>
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

          <div class="mb-4 grid grid-cols-2 gap-4">
            <div>
              <label class="label mb-1">Target category</label>
              <select v-model="importCategory" class="input">
                <option v-for="c in REAL_CATEGORIES" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
            </div>
            <div>
              <label class="label mb-1">Import mode</label>
              <div class="flex flex-col gap-1 pt-1">
                <label class="flex items-center text-sm">
                  <input v-model="importMode" type="radio" value="append" class="h-4 w-4 text-primary-600 border-gray-300" />
                  <span class="ml-2 text-gray-700">Append</span>
                </label>
                <label class="flex items-center text-sm">
                  <input v-model="importMode" type="radio" value="replace" class="h-4 w-4 text-primary-600 border-gray-300" />
                  <span class="ml-2 text-red-600">Replace</span>
                </label>
              </div>
            </div>
          </div>

          <div class="border rounded max-h-64 overflow-auto mb-4">
            <table class="min-w-full divide-y divide-gray-200 text-sm">
              <thead class="bg-gray-50 sticky top-0">
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">#</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Resource Name</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Source</th>
                  <th class="px-3 py-2 text-left text-xs font-medium text-gray-500">Identifier</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200">
                <tr v-for="(entry, i) in importPreview.slice(0, 50)" :key="i">
                  <td class="px-3 py-1 text-gray-400">{{ i + 1 }}</td>
                  <td class="px-3 py-1 text-gray-900">{{ entry.resourceName }}</td>
                  <td class="px-3 py-1 text-gray-500 max-w-xs truncate">{{ entry.source || '-' }}</td>
                  <td class="px-3 py-1 text-gray-500">{{ entry.identifier || '-' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="importPreview.length > 50" class="px-3 py-2 text-xs text-gray-400 bg-gray-50">... and {{ importPreview.length - 50 }} more entries</p>
          </div>
          <div v-if="importMode === 'replace'" class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            This will delete every existing entry in <strong>{{ importCategory }}</strong> before importing.
          </div>
          <div class="flex justify-end space-x-3">
            <button type="button" class="btn-secondary" @click="closeImportModal">Cancel</button>
            <button :disabled="importing" class="btn-primary" @click="handleImport">{{ importing ? 'Importing...' : `Import ${importPreview.length} entries` }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <div v-if="showCreateModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeCreateModal"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Add Entry</h2>
          <form class="space-y-3" @submit.prevent="handleCreate">
            <div>
              <label class="label">Category</label>
              <select v-model="createForm.category" class="input">
                <option v-for="c in REAL_CATEGORIES" :key="c.key" :value="c.key">{{ c.label }}</option>
              </select>
            </div>
            <div>
              <label class="label">Resource Type</label>
              <input v-model="createForm.resourceType" type="text" class="input" />
            </div>
            <div>
              <label class="label">Resource Name</label>
              <input v-model="createForm.resourceName" type="text" class="input" required placeholder="e.g. GraphPad Prism" />
            </div>
            <div>
              <label class="label">Source</label>
              <input v-model="createForm.source" type="text" class="input" placeholder="URL or vendor" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">Identifier</label>
                <input v-model="createForm.identifier" type="text" class="input" placeholder="RRID, DOI, etc." />
              </div>
              <div>
                <label class="label">New/Reuse</label>
                <select v-model="createForm.newReuse" class="input">
                  <option value="">-</option>
                  <option value="new">new</option>
                  <option value="reuse">reuse</option>
                </select>
              </div>
            </div>
            <div>
              <label class="label">Additional Information</label>
              <textarea v-model="createForm.additionalInformation" rows="2" class="input"></textarea>
            </div>
            <div>
              <label class="label">Suggested Entity <span class="text-gray-400 text-xs font-normal">(for matching)</span></label>
              <input v-model="createForm.suggestedEntity" type="text" class="input" />
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
  max-height: 480px;
  overflow-y: auto;
}
</style>
