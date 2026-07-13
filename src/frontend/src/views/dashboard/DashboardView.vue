<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import submissionService from '@/services/submission.service'
import SubmissionCard from '@/components/submission/SubmissionCard.vue'
import DeleteConfirmModal from '@/components/submission/DeleteConfirmModal.vue'
import SearchInput from '@/components/common/SearchInput.vue'

const router = useRouter()
const submissionStore = useSubmissionStore()
const authStore = useAuthStore()
const notificationStore = useNotificationStore()

// Filter state (arrays for multi-select)
const selectedStatuses = ref([])
const selectedProjects = ref([])
const selectedUsers = ref([])
const selectedVisibility = ref('visible') // 'visible' | 'hidden' | 'all'
const titleFilter = ref('') // server-side structured filter (by title)
const tableSearch = ref('') // client-side post-filter of the returned page

// Filter options from backend
const filterOptions = ref({ projects: [], users: [] })
const loadingOptions = ref(false)

// Dropdown visibility
const showStatusDropdown = ref(false)
const showProjectDropdown = ref(false)
const showUserDropdown = ref(false)

// Delete modal state
const showDeleteModal = ref(false)
const deletingSubmission = ref(null)
const deleteLoading = ref(false)

// View mode (card or table) — persisted to localStorage
const viewMode = ref(localStorage.getItem('dashboard-view-mode') || 'card')

function setViewMode(mode) {
  viewMode.value = mode
  localStorage.setItem('dashboard-view-mode', mode)
  tableSearch.value = '' // the in-table post-filter only exists in table view
}

// Bulk selection (table view)
const selectedIds = ref(new Set())
const bulkDeleting = ref(false)
const showBulkDeleteModal = ref(false)

const allOnPageSelected = computed(() => {
  if (submissions.value.length === 0) return false
  return submissions.value.every(s => selectedIds.value.has(s.id))
})

function toggleSelectAll() {
  if (allOnPageSelected.value) {
    submissions.value.forEach(s => selectedIds.value.delete(s.id))
  } else {
    submissions.value.forEach(s => selectedIds.value.add(s.id))
  }
  // Trigger reactivity
  selectedIds.value = new Set(selectedIds.value)
}

function toggleSelect(id) {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
  } else {
    selectedIds.value.add(id)
  }
  selectedIds.value = new Set(selectedIds.value)
}

function requestBulkDelete() {
  if (selectedIds.value.size === 0) return
  showBulkDeleteModal.value = true
}

async function confirmBulkDelete() {
  bulkDeleting.value = true
  let deleted = 0
  try {
    for (const id of selectedIds.value) {
      await submissionStore.deleteSubmission(id)
      deleted++
    }
    notificationStore.success(`${deleted} submission(s) deleted`)
    selectedIds.value = new Set()
    showBulkDeleteModal.value = false
    await fetchSubmissions()
  } catch (error) {
    notificationStore.error(`Deleted ${deleted}, then failed: ${error.response?.data?.error || error.message}`)
    showBulkDeleteModal.value = false
    await fetchSubmissions()
  } finally {
    bulkDeleting.value = false
  }
}

// Page size options
const pageSizeOptions = [12, 24, 48, 100]

async function bulkHide() {
  if (selectedIds.value.size === 0) return

  let hidden = 0
  try {
    for (const id of selectedIds.value) {
      await submissionStore.hideSubmission(id)
      hidden++
    }
    notificationStore.success(`${hidden} submission(s) hidden`)
    selectedIds.value = new Set()
    await fetchSubmissions()
  } catch (error) {
    notificationStore.error(`Hidden ${hidden}, then failed: ${error.response?.data?.error || error.message}`)
    await fetchSubmissions()
  }
}

async function bulkUnhide() {
  if (selectedIds.value.size === 0) return

  let unhidden = 0
  try {
    for (const id of selectedIds.value) {
      await submissionStore.unhideSubmission(id)
      unhidden++
    }
    notificationStore.success(`${unhidden} submission(s) restored`)
    selectedIds.value = new Set()
    await fetchSubmissions()
  } catch (error) {
    notificationStore.error(`Restored ${unhidden}, then failed: ${error.response?.data?.error || error.message}`)
    await fetchSubmissions()
  }
}

// Pagination
const currentPage = ref(1)
const itemsPerPage = ref(parseInt(localStorage.getItem('dashboard-page-size'), 10) || 12)

function setPageSize(size) {
  itemsPerPage.value = size
  localStorage.setItem('dashboard-page-size', size)
  currentPage.value = 1
  selectedIds.value = new Set()
  fetchSubmissions()
}

const submissions = computed(() => submissionStore.submissions)

// Client-side post-filter over the returned page: concatenate the displayed
// values of each row and substring-match. Complements the server-side filters.
const visibleSubmissions = computed(() => {
  const q = tableSearch.value.trim().toLowerCase()
  if (!q) return submissions.value
  return submissions.value.filter(s => {
    const haystack = [
      s.title, s.manuscriptId, s.project, s.status,
      s.user?.name, s.user?.email
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(q)
  })
})
const loading = computed(() => submissionStore.loading)
const pagination = computed(() => submissionStore.pagination)

const statusOptions = [
  { value: 'draft', label: 'Draft', color: 'bg-gray-100 text-gray-800' },
  { value: 'step_krt', label: 'KRT', color: 'bg-blue-100 text-blue-800' },
  { value: 'step_pdf', label: 'PDF', color: 'bg-purple-100 text-purple-800' },
  { value: 'step_review', label: 'Review', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'step_as', label: 'Availability', color: 'bg-amber-100 text-amber-800' },
  { value: 'step_report', label: 'Report', color: 'bg-orange-100 text-orange-800' },
  { value: 'completed', label: 'Completed', color: 'bg-green-100 text-green-800' }
]

const totalPages = computed(() => pagination.value?.totalPages || 1)

onMounted(async () => {
  await Promise.all([
    fetchFilterOptions(),
    fetchSubmissions()
  ])
})

async function fetchFilterOptions() {
  loadingOptions.value = true
  try {
    filterOptions.value = await submissionService.getFilterOptions()
  } catch (error) {
    // Options are optional, ignore errors
  } finally {
    loadingOptions.value = false
  }
}

async function fetchSubmissions() {
  const params = {
    page: currentPage.value,
    limit: itemsPerPage.value
  }

  if (selectedStatuses.value.length > 0) {
    params.status = selectedStatuses.value.join(',')
  }
  if (selectedProjects.value.length > 0) {
    params.project = selectedProjects.value.join(',')
  }
  if (selectedUsers.value.length > 0) {
    params.userId = selectedUsers.value.join(',')
  }
  if (selectedVisibility.value !== 'visible') {
    params.visibility = selectedVisibility.value
  }
  if (titleFilter.value.trim()) {
    params.title = titleFilter.value.trim()
  }

  await submissionStore.fetchSubmissions(params)
}

// Watch filters and refetch
watch([selectedStatuses, selectedProjects, selectedUsers, selectedVisibility], () => {
  currentPage.value = 1 // Reset to first page on filter change
  selectedIds.value = new Set()
  fetchSubmissions()
}, { deep: true })

// Debounced server-side title filter (structured — lives in the filters section)
let titleDebounce = null
watch(titleFilter, () => {
  clearTimeout(titleDebounce)
  titleDebounce = setTimeout(() => {
    currentPage.value = 1
    selectedIds.value = new Set()
    fetchSubmissions()
  }, 300)
})

watch(currentPage, () => {
  selectedIds.value = new Set()
  fetchSubmissions()
})

function toggleStatus(value) {
  const idx = selectedStatuses.value.indexOf(value)
  if (idx === -1) {
    selectedStatuses.value.push(value)
  } else {
    selectedStatuses.value.splice(idx, 1)
  }
}

function toggleProject(value) {
  const idx = selectedProjects.value.indexOf(value)
  if (idx === -1) {
    selectedProjects.value.push(value)
  } else {
    selectedProjects.value.splice(idx, 1)
  }
}

function toggleUser(value) {
  const idx = selectedUsers.value.indexOf(value)
  if (idx === -1) {
    selectedUsers.value.push(value)
  } else {
    selectedUsers.value.splice(idx, 1)
  }
}

function clearFilters() {
  selectedStatuses.value = []
  selectedProjects.value = []
  selectedUsers.value = []
  selectedVisibility.value = 'visible'
  titleFilter.value = ''
}

function getStatusLabel(value) {
  return statusOptions.find(s => s.value === value)?.label || value
}

function getStatusColor(value) {
  return statusOptions.find(s => s.value === value)?.color || 'bg-gray-100 text-gray-800'
}

function getUserName(userId) {
  const user = filterOptions.value.users.find(u => u.id === userId)
  return user?.name || user?.email || userId
}

function handleCreateNew() {
  router.push({ name: 'create-submission' })
}

function handleViewSubmission(submission) {
  const route = router.resolve({ name: 'submission-detail', params: { id: submission.id } })
  window.open(route.href, '_blank', 'noopener,noreferrer')
}

async function handleHideSubmission(submission) {
  try {
    await submissionStore.hideSubmission(submission.id)
    notificationStore.success('Submission hidden')
    await fetchSubmissions()
  } catch (error) {
    notificationStore.error('Failed to hide submission')
  }
}

async function handleUnhideSubmission(submission) {
  try {
    await submissionStore.unhideSubmission(submission.id)
    notificationStore.success('Submission restored')
    await fetchSubmissions()
  } catch (error) {
    notificationStore.error('Failed to restore submission')
  }
}

function handleDeleteSubmission(submission) {
  deletingSubmission.value = submission
  showDeleteModal.value = true
}

function closeDeleteModal() {
  showDeleteModal.value = false
  deletingSubmission.value = null
}

async function confirmDelete() {
  if (!deletingSubmission.value) return

  deleteLoading.value = true
  try {
    await submissionStore.deleteSubmission(deletingSubmission.value.id)
    notificationStore.success('Submission deleted')
    closeDeleteModal()
    // Refetch to update pagination and fill the page with remaining items
    await fetchSubmissions()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete submission')
  } finally {
    deleteLoading.value = false
  }
}

function goToPage(page) {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page
  }
}

// Close dropdowns when clicking outside
function closeDropdowns(event) {
  if (!event.target.closest('.filter-dropdown')) {
    showStatusDropdown.value = false
    showProjectDropdown.value = false
    showUserDropdown.value = false
  }
}

// Role-based permissions
const canDelete = computed(() => authStore.canDeleteSubmission)
const canFilterTeamAndAuthor = computed(() => ['admin', 'ds_annotator', 'asap_pm'].includes(authStore.effectiveRole))

const activeFilterCount = computed(() => {
  let count = selectedStatuses.value.length + selectedProjects.value.length + selectedUsers.value.length
  if (selectedVisibility.value !== 'visible') count++
  if (titleFilter.value.trim()) count++
  return count
})
</script>

<template>
  <div @click="closeDropdowns" class="h-full flex flex-col">
    <!-- Header with CTA -->
    <div class="card mb-6 flex-shrink-0 bg-gradient-to-r from-primary-50 to-primary-100 border-primary-200">
      <div>
        <h1 class="text-2xl font-bold text-primary-900">Dashboard</h1>
      </div>
    </div>

    <!-- Filters -->
    <div class="card mb-6 flex-shrink-0">
      <div v-if="activeFilterCount > 0" class="flex justify-end mb-2">
        <button
          class="text-sm text-gray-500 hover:text-gray-700 flex items-center"
          @click="clearFilters"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Clear all ({{ activeFilterCount }})
        </button>
      </div>

      <div class="flex flex-wrap items-start gap-4">
        <!-- Title (structured, server-side) -->
        <div class="filter-dropdown relative" @click.stop>
          <label class="label">Title</label>
          <div class="w-40">
            <SearchInput v-model="titleFilter" full-width placeholder="Search…" />
          </div>
        </div>

        <!-- Status Multi-Select -->
        <div class="filter-dropdown relative">
          <label class="label">Status</label>
          <button
            class="input w-56 text-left flex items-center justify-between"
            @click.stop="showStatusDropdown = !showStatusDropdown; showProjectDropdown = false; showUserDropdown = false"
          >
            <span v-if="selectedStatuses.length === 0" class="text-gray-400">All statuses</span>
            <span v-else class="truncate">{{ selectedStatuses.length }} selected</span>
            <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <div
            v-if="showStatusDropdown"
            class="absolute z-20 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-auto"
          >
            <div
              v-for="option in statusOptions"
              :key="option.value"
              class="px-3 py-2 hover:bg-gray-50 cursor-pointer flex items-center"
              @click.stop="toggleStatus(option.value)"
            >
              <input
                type="checkbox"
                :checked="selectedStatuses.includes(option.value)"
                class="mr-2 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                @click.stop
                @change="toggleStatus(option.value)"
              />
              <span :class="['px-2 py-0.5 rounded text-xs font-medium', option.color]">
                {{ option.label }}
              </span>
            </div>
          </div>
        </div>

        <!-- Project Multi-Select (all roles — a filter for clarity) -->
        <div v-if="filterOptions.projects.length > 0" class="filter-dropdown relative">
          <label class="label">Project</label>
          <button
            class="input w-40 text-left flex items-center justify-between"
            @click.stop="showProjectDropdown = !showProjectDropdown; showStatusDropdown = false; showUserDropdown = false"
          >
            <span v-if="selectedProjects.length === 0" class="text-gray-400">All projects</span>
            <span v-else class="truncate">{{ selectedProjects.length }} selected</span>
            <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <div
            v-if="showProjectDropdown"
            class="absolute z-20 mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-auto"
          >
            <div
              v-for="project in filterOptions.projects"
              :key="project"
              class="px-3 py-2 hover:bg-gray-50 cursor-pointer flex items-center"
              @click.stop="toggleProject(project)"
            >
              <input
                type="checkbox"
                :checked="selectedProjects.includes(project)"
                class="mr-2 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                @click.stop
                @change="toggleProject(project)"
              />
              <span class="text-sm">{{ project }}</span>
            </div>
          </div>
        </div>

        <!-- User Multi-Select (asap_pm, ds_annotator, admin) -->
        <div v-if="canFilterTeamAndAuthor && filterOptions.users.length > 0" class="filter-dropdown relative">
          <label class="label">Author</label>
          <button
            class="input w-48 text-left flex items-center justify-between"
            @click.stop="showUserDropdown = !showUserDropdown; showStatusDropdown = false; showProjectDropdown = false"
          >
            <span v-if="selectedUsers.length === 0" class="text-gray-400">All authors</span>
            <span v-else class="truncate">{{ selectedUsers.length }} selected</span>
            <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <div
            v-if="showUserDropdown"
            class="absolute z-20 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-auto"
          >
            <div
              v-for="user in filterOptions.users"
              :key="user.id"
              class="px-3 py-2 hover:bg-gray-50 cursor-pointer flex items-center"
              @click.stop="toggleUser(user.id)"
            >
              <input
                type="checkbox"
                :checked="selectedUsers.includes(user.id)"
                class="mr-2 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                @click.stop
                @change="toggleUser(user.id)"
              />
              <div class="min-w-0">
                <p class="text-sm font-medium text-gray-900 truncate">{{ user.name }}</p>
                <p class="text-xs text-gray-500 truncate">{{ user.email }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Visibility filter -->
        <div>
          <label class="label">Visibility</label>
          <div class="flex border border-gray-300 rounded-md overflow-hidden">
            <button
              v-for="opt in [{ value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }, { value: 'all', label: 'All' }]"
              :key="opt.value"
              class="px-3 py-1.5 text-sm font-medium transition-colors"
              :class="selectedVisibility === opt.value
                ? 'bg-primary-100 text-primary-700'
                : 'text-gray-600 hover:bg-gray-50'"
              @click="selectedVisibility = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
      </div>

      <!-- Active filters chips -->
      <div v-if="activeFilterCount > 0" class="flex flex-wrap gap-2 mt-4 pt-4 border-t">
        <span
          v-for="status in selectedStatuses"
          :key="`status-${status}`"
          :class="['inline-flex items-center px-2 py-1 rounded-full text-xs font-medium', getStatusColor(status)]"
        >
          {{ getStatusLabel(status) }}
          <button class="ml-1 hover:opacity-70" @click="toggleStatus(status)">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
        <span
          v-for="project in selectedProjects"
          :key="`project-${project}`"
          class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800"
        >
          Project: {{ project }}
          <button class="ml-1 hover:opacity-70" @click="toggleProject(project)">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
        <span
          v-for="userId in selectedUsers"
          :key="`user-${userId}`"
          class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-pink-100 text-pink-800"
        >
          {{ getUserName(userId) }}
          <button class="ml-1 hover:opacity-70" @click="toggleUser(userId)">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
        <span
          v-if="selectedVisibility !== 'visible'"
          class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-800"
        >
          {{ selectedVisibility === 'hidden' ? 'Hidden only' : 'All visibility' }}
          <button class="ml-1 hover:opacity-70" @click="selectedVisibility = 'visible'">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      </div>
    </div>

    <!-- Results summary + view toggle -->
    <div class="flex items-center justify-between mb-4 flex-shrink-0">
      <p class="text-sm text-gray-500">
        <span v-if="loading">Loading...</span>
        <span v-else>
          Showing {{ submissions.length }} of {{ pagination.total || 0 }} submissions
        </span>
      </p>
      <!-- View mode toggle -->
      <div class="flex items-center border border-gray-300 rounded-md overflow-hidden">
        <button
          class="p-1.5 transition-colors"
          :class="viewMode === 'card' ? 'bg-primary-100 text-primary-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'"
          title="Card view"
          @click="setViewMode('card')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
        </button>
        <button
          class="p-1.5 transition-colors"
          :class="viewMode === 'table' ? 'bg-primary-100 text-primary-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'"
          title="Table view"
          @click="setViewMode('table')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Results region — fills the remaining page height -->
    <div class="flex-1 min-h-0 flex flex-col">
    <!-- Loading state -->
    <div v-if="loading" class="flex-1 flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <!-- Empty state -->
    <div v-else-if="submissions.length === 0" class="card text-center py-12">
      <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <h3 class="mt-2 text-sm font-medium text-gray-900">No submissions found</h3>
      <p class="mt-1 text-sm text-gray-500">
        <span v-if="activeFilterCount > 0">Try adjusting your filters or </span>
        <span v-else>Get started by </span>
        creating a new submission.
      </p>
      <div class="mt-6">
        <button class="btn-primary" @click="handleCreateNew">
          New Submission
        </button>
      </div>
    </div>

    <!-- Submissions grid (card view) — no in-table post-filter here -->
    <template v-else-if="viewMode === 'card'">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 flex-1 min-h-0 overflow-y-auto content-start">
        <SubmissionCard
          v-for="submission in submissions"
          :key="submission.id"
          :submission="submission"
          :is-hidden="selectedVisibility === 'hidden'"
          @click="handleViewSubmission(submission)"
          @hide="handleHideSubmission"
          @unhide="handleUnhideSubmission"
          @delete="handleDeleteSubmission"
        />
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1 || itemsPerPage !== 12" class="mt-4 flex-shrink-0 flex items-center justify-between">
        <!-- Page size selector -->
        <div class="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            :value="itemsPerPage"
            class="border border-gray-300 rounded-md px-2 py-1 text-sm focus:ring-primary-500 focus:border-primary-500"
            @change="setPageSize(Number($event.target.value))"
          >
            <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
          </select>
          <span>per page</span>
        </div>

        <!-- Page navigation -->
        <div class="flex items-center space-x-2">
          <button
            :disabled="currentPage === 1"
            class="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="goToPage(currentPage - 1)"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <template v-for="page in totalPages" :key="page">
            <button
              v-if="page === 1 || page === totalPages || (page >= currentPage - 1 && page <= currentPage + 1)"
              :class="[
                'px-4 py-2 rounded-md text-sm font-medium',
                currentPage === page
                  ? 'bg-primary-600 text-white'
                  : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
              ]"
              @click="goToPage(page)"
            >
              {{ page }}
            </button>
            <span
              v-else-if="page === currentPage - 2 || page === currentPage + 2"
              class="px-2 text-gray-400"
            >
              ...
            </span>
          </template>

          <button
            :disabled="currentPage === totalPages"
            class="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="goToPage(currentPage + 1)"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </template>

    <!-- Submissions table (table view) -->
    <template v-else>
      <!-- Bulk actions bar -->
      <div v-if="selectedIds.size > 0" class="mb-4 flex items-center gap-3 p-3 bg-primary-50 border border-primary-200 rounded-lg">
        <span class="text-sm font-medium text-primary-800">{{ selectedIds.size }} selected</span>
        <button
          v-if="canDelete"
          :disabled="bulkDeleting"
          class="px-3 py-1 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          @click="requestBulkDelete"
        >
          <span v-if="bulkDeleting">Deleting...</span>
          <span v-else>Delete selected</span>
        </button>
        <button
          v-if="selectedVisibility === 'hidden'"
          class="px-3 py-1 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700"
          @click="bulkUnhide"
        >
          Unhide selected
        </button>
        <button
          v-else
          class="px-3 py-1 text-xs font-medium rounded-md bg-gray-600 text-white hover:bg-gray-700"
          @click="bulkHide"
        >
          Hide selected
        </button>
        <button
          class="px-3 py-1 text-xs font-medium rounded-md text-gray-600 hover:text-gray-800"
          @click="selectedIds = new Set()"
        >
          Clear selection
        </button>
      </div>

      <div class="card overflow-hidden !p-0 flex-1 min-h-0 flex flex-col">
        <div class="flex-1 min-h-0 overflow-y-auto">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th colspan="9" class="px-4 py-3 bg-white border-b border-gray-200">
                  <SearchInput v-model="tableSearch" full-width placeholder="Search these results…" />
                </th>
              </tr>
              <tr>
                <th class="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    :checked="allOnPageSelected"
                    class="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    @change="toggleSelectAll"
                  />
                </th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Manuscript ID</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Project</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Author</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Round</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <tr v-if="visibleSubmissions.length === 0">
                <td colspan="9" class="px-4 py-8 text-center text-gray-500">
                  No results on this page match “{{ tableSearch }}”.
                </td>
              </tr>
              <tr
                v-for="sub in visibleSubmissions"
                :key="sub.id"
                class="hover:bg-gray-50 transition-colors"
                :class="{ 'bg-primary-50/30': selectedIds.has(sub.id) }"
              >
                <td class="px-3 py-3">
                  <input
                    type="checkbox"
                    :checked="selectedIds.has(sub.id)"
                    class="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    @change="toggleSelect(sub.id)"
                  />
                </td>
                <td class="px-4 py-3">
                  <button
                    class="text-sm font-medium text-primary-700 hover:text-primary-900 hover:underline text-left max-w-xs truncate block"
                    :title="sub.title"
                    @click="handleViewSubmission(sub)"
                  >
                    {{ sub.title }}
                  </button>
                </td>
                <td class="px-4 py-3 text-sm text-gray-600 font-mono">
                  {{ sub.manuscriptId || '—' }}
                </td>
                <td class="px-4 py-3 text-sm text-gray-600">
                  {{ sub.project || '—' }}
                </td>
                <td class="px-4 py-3 text-sm text-gray-600 truncate max-w-[120px]">
                  {{ sub.user?.name || '—' }}
                </td>
                <td class="px-4 py-3">
                  <span :class="['px-2 py-0.5 rounded text-xs font-medium', getStatusColor(sub.status)]">
                    {{ getStatusLabel(sub.status) }}
                  </span>
                </td>
                <td class="px-4 py-3 text-sm text-gray-600 text-center">
                  v{{ sub.currentRound || 1 }}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">
                  {{ new Date(sub.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }}
                </td>
                <td class="px-4 py-3 text-right">
                  <div class="flex items-center justify-end space-x-1">
                    <button
                      v-if="selectedVisibility === 'hidden'"
                      class="p-1 text-gray-400 hover:text-green-600 transition-colors"
                      title="Unhide"
                      @click="handleUnhideSubmission(sub)"
                    >
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                    <button
                      v-else
                      class="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                      title="Hide"
                      @click="handleHideSubmission(sub)"
                    >
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    </button>
                    <button
                      v-if="canDelete"
                      class="p-1 text-gray-400 hover:text-red-600 transition-colors"
                      title="Delete"
                      @click="handleDeleteSubmission(sub)"
                    >
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Pagination (table view) -->
      <div v-if="totalPages > 1 || itemsPerPage !== 12" class="mt-4 flex-shrink-0 flex items-center justify-between">
        <!-- Page size selector -->
        <div class="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            :value="itemsPerPage"
            class="border border-gray-300 rounded-md px-2 py-1 text-sm focus:ring-primary-500 focus:border-primary-500"
            @change="setPageSize(Number($event.target.value))"
          >
            <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
          </select>
          <span>per page</span>
        </div>

        <!-- Page navigation -->
        <div class="flex items-center space-x-2">
          <button
            :disabled="currentPage === 1"
            class="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="goToPage(currentPage - 1)"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <template v-for="page in totalPages" :key="page">
            <button
              v-if="page === 1 || page === totalPages || (page >= currentPage - 1 && page <= currentPage + 1)"
              :class="[
                'px-4 py-2 rounded-md text-sm font-medium',
                currentPage === page
                  ? 'bg-primary-600 text-white'
                  : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
              ]"
              @click="goToPage(page)"
            >
              {{ page }}
            </button>
            <span
              v-else-if="page === currentPage - 2 || page === currentPage + 2"
              class="px-2 text-gray-400"
            >
              ...
            </span>
          </template>

          <button
            :disabled="currentPage === totalPages"
            class="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            @click="goToPage(currentPage + 1)"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </template>
    </div><!-- /results region -->

    <!-- Delete Confirmation Modal (single) -->
    <DeleteConfirmModal
      :show="showDeleteModal"
      :submission="deletingSubmission"
      :loading="deleteLoading"
      @close="closeDeleteModal"
      @confirm="confirmDelete"
    />

    <!-- Bulk Delete Confirmation Modal -->
    <Teleport to="body">
      <div v-if="showBulkDeleteModal" class="fixed inset-0 z-50 flex items-center justify-center">
        <div class="absolute inset-0 bg-black/50" @click="showBulkDeleteModal = false"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
          <div class="flex items-center mb-4">
            <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center mr-3">
              <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 class="text-lg font-semibold text-gray-900">Delete {{ selectedIds.size }} submission(s)?</h3>
          </div>
          <p class="text-sm text-gray-600 mb-6">
            This will permanently delete the selected submissions and all associated data. This action cannot be undone.
          </p>
          <div class="flex justify-end space-x-3">
            <button
              class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
              :disabled="bulkDeleting"
              @click="showBulkDeleteModal = false"
            >
              Cancel
            </button>
            <button
              class="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
              :disabled="bulkDeleting"
              @click="confirmBulkDelete"
            >
              <span v-if="bulkDeleting">Deleting...</span>
              <span v-else>Delete {{ selectedIds.size }} submission(s)</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
