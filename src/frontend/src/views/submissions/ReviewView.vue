<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSubmissionStore } from '@/stores/submission.store'
import { useKRTStore } from '@/stores/krt.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import { setSubmissionTitle } from '@/router'
import submissionService from '@/services/submission.service'
import suggestionService from '@/services/suggestion.service'
import SubmissionHeader from '@/components/submission/SubmissionHeader.vue'

const route = useRoute()
const router = useRouter()
const submissionStore = useSubmissionStore()
const krtStore = useKRTStore()
const notificationStore = useNotificationStore()
const resourceTypesStore = useResourceTypesStore()

const submission = computed(() => submissionStore.currentSubmission)
const latestFiles = computed(() => submissionStore.latestFiles)
const krtRows = computed(() => krtStore.rows)

// Step help items
const helpItems = computed(() => [
  {
    title: 'Review the updated KRT',
    children: ['Edits, additions, and deletions are highlighted in the table below'],
    done: false
  },
  {
    title: 'Click "Continue" to approve the KRT and proceed to Step 4',
    done: false
  }
])

// Change history state
const changes = ref([])
const deletedRows = ref([])
const showDetails = ref(true)
const loadingChanges = ref(false)

// Rejected AI suggestions for the current round — surfaced here so the
// curator can audit what was discarded during step 2 before approving the KRT.
// Displayed as a carousel (matches the AI suggestions UI in step 2).
const allSuggestions = ref([])
const rejectedSuggestions = computed(() =>
  allSuggestions.value.filter(s => s.status === 'rejected')
)
const currentRejectedIndex = ref(0)
const currentRejectedSuggestion = computed(
  () => rejectedSuggestions.value[currentRejectedIndex.value] || null
)
function goToPrevRejected() {
  if (currentRejectedIndex.value > 0) currentRejectedIndex.value--
}
function goToNextRejected() {
  if (currentRejectedIndex.value < rejectedSuggestions.value.length - 1) {
    currentRejectedIndex.value++
  }
}
function goToRejected(index) {
  currentRejectedIndex.value = index
}
// Reset carousel index whenever the underlying list changes (length differs).
watch(() => rejectedSuggestions.value.length, () => {
  currentRejectedIndex.value = 0
})

// Collapsible summary state
const summaryExpanded = ref(true)

// Filter tabs for resource types
const tabGroups = [
  { key: 'all', label: 'All' },
  { key: 'Datasets', label: 'Datasets' },
  { key: 'Software/code', label: 'Software/code' },
  { key: 'Protocols', label: 'Protocols' },
  { key: 'Lab Materials', label: 'Key Lab Materials' }
]
const activeTab = ref('all')

// History modal state
const historyModal = ref({
  show: false,
  columnLabel: '',
  cellData: null
})

function openHistoryModal(row, columnKey, columnLabel) {
  const cellData = getCellChange(row, columnKey)
  if (cellData) {
    historyModal.value = {
      show: true,
      columnLabel,
      cellData
    }
  }
}

function closeHistoryModal() {
  historyModal.value.show = false
}

// Build a map of cell change history by row ID: { rowId: { columnName: { history: [], original, final } } }
const cellChanges = computed(() => {
  const map = {}
  for (const change of changes.value) {
    const key = change.rowId
    if (change.action === 'edit' && change.rowId && change.columnName) {
      if (!map[key]) map[key] = {}
      if (!map[key][change.columnName]) {
        map[key][change.columnName] = { history: [] }
      }
      map[key][change.columnName].history.push(change)
    }
  }

  // Sort history by date and compute original/final values
  for (const rowKey of Object.keys(map)) {
    for (const colName of Object.keys(map[rowKey])) {
      const cell = map[rowKey][colName]
      // Sort oldest first
      cell.history.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      // Original value is from the first change
      cell.original = cell.history[0]?.oldValue
      // Final value is from the last change
      cell.final = cell.history[cell.history.length - 1]?.newValue
      // Last change info (for highlighting color based on most recent source)
      cell.lastChange = cell.history[cell.history.length - 1]
    }
  }
  return map
})

// Track added rows by rowId: { rowId: changeInfo }
const addedRows = computed(() => {
  const map = {}
  for (const change of changes.value) {
    if (change.action === 'add_row') {
      const key = change.rowId
      // Use source field to determine if from AI or manual
      const fromAI = change.source === 'ai_suggestion'
      const fromValidation = change.source === 'krt_validation'
      const fromManual = change.source === 'manual' || (!fromAI && !fromValidation)
      map[key] = { ...change, fromAI, fromValidation, fromManual }
    }
  }
  return map
})

// Resource type group order for sorting (matches KRTEditor)
function getResourceGroupForSort(resourceType) {
  const rt = (resourceType || '').toLowerCase()
  if (rt.includes('dataset')) return 0
  if (rt.includes('software') || rt.includes('code')) return 1
  if (rt.includes('protocol')) return 2
  return 3
}

// Combined rows: current rows + deleted rows (interleaved in original order)
const allCombinedRows = computed(() => {
  const currentRows = krtRows.value.map(row => ({ ...row, isDeleted: false }))

  if (!showDetails.value) {
    return currentRows
  }

  // Format deleted rows with same column structure
  const deletedRowsFormatted = deletedRows.value.map((deleted, index) => ({
    id: `deleted-${index}`,
    'RESOURCE TYPE': deleted.metadata?.resourceType || '-',
    'RESOURCE NAME': deleted.resourceName || '-',
    'SOURCE': deleted.metadata?.source || '-',
    'IDENTIFIER': deleted.metadata?.identifier || '-',
    'NEW/REUSE': deleted.metadata?.newReuse || '-',
    'ADDITIONAL INFORMATION': deleted.metadata?.additionalInformation || '-',
    isDeleted: true,
    deletedBy: deleted.deletedBy,
    deletedAt: deleted.deletedAt,
    deletedSource: deleted.source
  }))

  // Combine and sort by resource type group, then by name
  const combined = [...currentRows, ...deletedRowsFormatted]
  combined.sort((a, b) => {
    const groupA = getResourceGroupForSort(a['RESOURCE TYPE'])
    const groupB = getResourceGroupForSort(b['RESOURCE TYPE'])
    if (groupA !== groupB) return groupA - groupB
    const nameA = (a['RESOURCE NAME'] || '').toLowerCase()
    const nameB = (b['RESOURCE NAME'] || '').toLowerCase()
    return nameA.localeCompare(nameB)
  })

  return combined
})

// Check if a row matches a tab (uses DB resource type categories)
function rowMatchesTab(row, tabKey) {
  if (tabKey === 'all') return true
  const resourceType = row['RESOURCE TYPE'] || ''
  if (!resourceType) return false
  return resourceTypesStore.getTabGroup(resourceType) === tabKey
}

// Filter rows by resource type tab
const combinedRows = computed(() => {
  if (activeTab.value === 'all') {
    return allCombinedRows.value
  }
  return allCombinedRows.value.filter(row => rowMatchesTab(row, activeTab.value))
})

// Count rows per tab
function getTabCount(tabKey) {
  if (tabKey === 'all') return allCombinedRows.value.length
  return allCombinedRows.value.filter(row => rowMatchesTab(row, tabKey)).length
}

function isRowAdded(row) {
  return !!addedRows.value[row.id]
}

function getAddedRowInfo(row) {
  return addedRows.value[row.id]
}

// Map column keys to field names used in change log
const columnKeyToField = {
  'RESOURCE TYPE': 'resource_type',
  'RESOURCE NAME': 'resource_name',
  'SOURCE': 'source',
  'IDENTIFIER': 'identifier',
  'NEW/REUSE': 'new_reuse',
  'ADDITIONAL INFORMATION': 'additional_information'
}

function getCellChange(row, columnKey) {
  const fieldName = columnKeyToField[columnKey]
  return cellChanges.value[row.id]?.[fieldName] || null
}

function hasCellChange(row, columnKey) {
  return !!getCellChange(row, columnKey)
}

function getChangeSource(change) {
  // Use the source field to determine the change origin
  if (change.source === 'ai_suggestion') return 'AI Suggestion'
  if (change.source === 'krt_validation') return 'KRT Validation'
  if (change.source === 'manual') return 'Manual Edit'
  // Fallback for legacy data without source field
  if (change.action === 'approve_change') return 'AI Suggestion'
  return 'Manual Edit'
}

function getChangeSourceClass(change) {
  // Use the source field to determine styling
  if (change.source === 'ai_suggestion') return 'source-ai'
  if (change.source === 'krt_validation') return 'source-validation'
  if (change.source === 'manual') return 'source-manual'
  // Fallback for legacy data
  if (change.action === 'approve_change') return 'source-ai'
  return 'source-manual'
}

function formatTime(dateStr) {
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const isAlreadyApproved = computed(() => {
  const status = submission.value?.status
  return ['step_as', 'step_report', 'completed'].includes(status)
})

const changeStats = computed(() => {
  // Filter cell updates (edits with column name)
  const cellUpdates = changes.value.filter(c => c.action === 'edit' && c.columnName)
  const cellUpdatesFromAI = cellUpdates.filter(c => c.source === 'ai_suggestion').length
  const cellUpdatesFromValidation = cellUpdates.filter(c => c.source === 'krt_validation').length

  // Filter row additions
  const rowAdds = changes.value.filter(c => c.action === 'add_row')
  const rowAddsFromAI = rowAdds.filter(c => c.source === 'ai_suggestion').length

  // Filter row deletions
  const rowDeletes = changes.value.filter(c => c.action === 'delete_row')
  const rowDeletesFromAI = rowDeletes.filter(c => c.source === 'ai_suggestion').length

  return {
    updated: cellUpdates.length,
    updatedFromAI: cellUpdatesFromAI,
    updatedFromValidation: cellUpdatesFromValidation,
    added: rowAdds.length,
    addedFromAI: rowAddsFromAI,
    removed: rowDeletes.length,
    removedFromAI: rowDeletesFromAI
  }
})

const hasChanges = computed(() => {
  return changeStats.value.updated > 0 || changeStats.value.added > 0 || changeStats.value.removed > 0
})

onMounted(async () => {
  krtStore.clearKRT()
  allSuggestions.value = []
  resourceTypesStore.fetchResourceTypeNames().catch(() => {})
  await submissionStore.fetchSubmission(route.params.id)
  await krtStore.fetchKRT(route.params.id)
  await fetchChanges()
  await fetchSuggestions()
})

async function fetchSuggestions() {
  try {
    const result = await suggestionService.getSuggestions(route.params.id)
    allSuggestions.value = result.suggestions || []
  } catch {
    allSuggestions.value = []
  }
}

async function fetchChanges() {
  loadingChanges.value = true
  try {
    const result = await submissionService.getChanges(route.params.id, { limit: 500 })
    changes.value = result.changes || []

    deletedRows.value = changes.value
      .filter(c => c.action === 'delete_row')
      .map(c => ({
        rowId: c.rowId,
        resourceName: c.description?.replace('Deleted row: ', '') || 'Unknown',
        deletedBy: c.user?.name || 'Unknown',
        deletedAt: c.createdAt,
        source: c.source || 'manual',
        metadata: c.metadata || {}
      }))
  } catch (error) {
    console.error('Failed to fetch changes:', error)
  } finally {
    loadingChanges.value = false
  }
}

watch(submission, (sub) => {
  if (sub) {
    setSubmissionTitle(sub.manuscriptId || sub.title, 'Step 3: Approve KRT')
  }
}, { immediate: true })

async function handleApprove() {
  if (isAlreadyApproved.value) {
    router.push({ name: 'submission-availability', params: { id: route.params.id } })
    return
  }

  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_as' })
    notificationStore.success('Submission approved')
    router.push({ name: 'submission-availability', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to approve submission')
  }
}

async function handleBack() {
  try {
    await submissionStore.updateSubmission(route.params.id, { status: 'step_pdf' })
    router.push({ name: 'submission-pdf', params: { id: route.params.id } })
  } catch (error) {
    notificationStore.error('Failed to go back')
  }
}

const columns = [
  { key: 'RESOURCE TYPE', label: 'RESOURCE TYPE' },
  { key: 'RESOURCE NAME', label: 'RESOURCE NAME' },
  { key: 'SOURCE', label: 'SOURCE' },
  { key: 'IDENTIFIER', label: 'IDENTIFIER' },
  { key: 'NEW/REUSE', label: 'NEW/REUSE' },
  { key: 'ADDITIONAL INFORMATION', label: 'ADDITIONAL INFO' }
]

// Check if a row has any cell-level changes (edits)
function isRowUpdated(row) {
  return !!cellChanges.value[row.id]
}

// Get source tag info for a deleted row
function getDeletedSourceTag(row) {
  if (row.deletedSource === 'ai_suggestion') return { label: 'AI', class: 'source-tag-ai' }
  if (row.deletedSource === 'krt_validation') return { label: 'Val', class: 'source-tag-validation' }
  return { label: 'User', class: 'source-tag-manual' }
}

// Get source tag info for an added row
function getAddedSourceTag(row) {
  const info = getAddedRowInfo(row)
  if (info?.fromAI) return { label: 'AI', class: 'source-tag-ai' }
  if (info?.fromValidation) return { label: 'Val', class: 'source-tag-validation' }
  return { label: 'User', class: 'source-tag-manual' }
}

// Get source tag info for an updated row (based on most recent change source)
function getUpdatedSourceTag(row) {
  const rowChanges = cellChanges.value[row.id]
  if (!rowChanges) return { label: 'User', class: 'source-tag-manual' }
  // Find the most recent change across all columns
  let latestChange = null
  for (const colName of Object.keys(rowChanges)) {
    const cell = rowChanges[colName]
    if (cell.lastChange) {
      if (!latestChange || new Date(cell.lastChange.createdAt) > new Date(latestChange.createdAt)) {
        latestChange = cell.lastChange
      }
    }
  }
  if (latestChange?.source === 'ai_suggestion') return { label: 'AI', class: 'source-tag-ai' }
  if (latestChange?.source === 'krt_validation') return { label: 'Val', class: 'source-tag-validation' }
  return { label: 'User', class: 'source-tag-manual' }
}

// Get the source tag for any row (added, updated, deleted)
function getRowSourceTag(row) {
  if (row.isDeleted) return getDeletedSourceTag(row)
  if (isRowAdded(row)) return getAddedSourceTag(row)
  if (isRowUpdated(row)) return getUpdatedSourceTag(row)
  return null
}

// Legend toggle: set of hidden source tags (toggle to show/hide)
const hiddenSources = ref(new Set())

function toggleSourceVisibility(source) {
  const newSet = new Set(hiddenSources.value)
  if (newSet.has(source)) {
    newSet.delete(source)
  } else {
    newSet.add(source)
  }
  hiddenSources.value = newSet
}

// Filter combinedRows by hiding toggled-off sources
const filteredCombinedRows = computed(() => {
  if (hiddenSources.value.size === 0) return combinedRows.value
  return combinedRows.value.filter(row => {
    const tag = getRowSourceTag(row)
    if (!tag) return true // Unchanged rows are always shown
    return !hiddenSources.value.has(tag.label)
  })
})

// Row classes based on action type (not source)
function getRowClass(row) {
  if (!showDetails.value) return ''
  if (row.isDeleted) return 'row-deleted'
  if (isRowAdded(row)) return 'row-added'
  if (isRowUpdated(row)) return 'row-updated'
  return ''
}

// Cell classes: uniform highlight for any changed cell
function getCellClass(row, columnKey) {
  if (!showDetails.value) return ''
  if (row.isDeleted) return ''
  if (hasCellChange(row, columnKey)) return 'cell-changed'
  return ''
}
</script>

<template>
  <div class="space-y-6">
    <SubmissionHeader
      :submission="submission"
      :latest-files="latestFiles"
      step-title="Step 3: Approve KRT"
      step-description="Review and approve all changes made to the KRT"
      :help-items="helpItems"
      :show-navigation="true"
      :can-go-back="true"
      :can-go-next="true"
      @go-back="handleBack"
      @go-next="handleApprove"
    />

    <!-- Already approved notice -->
    <div v-if="isAlreadyApproved" class="card bg-green-50 border-green-200">
      <div class="flex items-center">
        <svg class="w-6 h-6 text-green-500 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-green-800">This submission has already been approved. You can proceed to Step 4.</p>
      </div>
    </div>

    <!-- Summary (Collapsible) -->
    <div class="card">
      <button
        class="w-full flex items-center justify-between text-left"
        @click="summaryExpanded = !summaryExpanded"
      >
        <h2 class="text-lg font-medium">Submission Summary</h2>
        <svg
          class="w-5 h-5 text-gray-500 transition-transform"
          :class="{ 'rotate-180': summaryExpanded }"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <dl v-show="summaryExpanded" class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
        <div>
          <dt class="text-sm text-gray-500">Title</dt>
          <dd class="font-medium">{{ submission?.title }}</dd>
        </div>
        <div>
          <dt class="text-sm text-gray-500">Manuscript ID</dt>
          <dd class="font-medium">{{ submission?.manuscriptId }}</dd>
        </div>
        <div>
          <dt class="text-sm text-gray-500">Team</dt>
          <dd class="font-medium">{{ submission?.team || 'N/A' }}</dd>
        </div>
        <div>
          <dt class="text-sm text-gray-500">Total Resources</dt>
          <dd class="font-medium">{{ krtRows.length }}</dd>
        </div>
      </dl>
    </div>

    <!-- No changes message -->
    <div v-if="!hasChanges && !loadingChanges" class="card bg-gray-50 border-gray-200">
      <div class="flex items-center">
        <svg class="w-5 h-5 text-gray-400 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-gray-600">No changes have been made to this KRT. The data below is the original uploaded version.</p>
      </div>
    </div>

    <!-- Change Statistics (only shown if there are changes) -->
    <div v-if="hasChanges" class="card">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-medium">Changes Made</h2>
      </div>
      <div class="grid grid-cols-3 gap-4">
        <div v-if="changeStats.updated > 0" class="stat-card stat-updated">
          <div class="stat-number">{{ changeStats.updated }}</div>
          <div class="stat-label">
            Cells Updated
            <span v-if="changeStats.updatedFromAI > 0" class="stat-source-badge stat-ai-badge">{{ changeStats.updatedFromAI }} from AI</span>
            <span v-if="changeStats.updatedFromValidation > 0" class="stat-source-badge stat-validation-badge">{{ changeStats.updatedFromValidation }} from validation</span>
          </div>
        </div>
        <div v-if="changeStats.added > 0" class="stat-card stat-added">
          <div class="stat-number">{{ changeStats.added }}</div>
          <div class="stat-label">
            Rows Added
            <span v-if="changeStats.addedFromAI > 0" class="stat-source-badge stat-ai-badge">{{ changeStats.addedFromAI }} from AI</span>
          </div>
        </div>
        <div v-if="changeStats.removed > 0" class="stat-card stat-deleted">
          <div class="stat-number">{{ changeStats.removed }}</div>
          <div class="stat-label">
            Rows Removed
            <span v-if="changeStats.removedFromAI > 0" class="stat-source-badge stat-ai-badge">{{ changeStats.removedFromAI }} from AI</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Rejected AI suggestions (read-only audit trail from step 2) -->
    <div v-if="rejectedSuggestions.length > 0" class="card">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-medium">Rejected AI Suggestions</h2>
        <span class="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
          {{ currentRejectedIndex + 1 }} / {{ rejectedSuggestions.length }}
        </span>
      </div>
      <p class="text-sm text-gray-500 mb-4">
        Suggestions you discarded during step 2. Kept here for reference — they are not part of your KRT.
      </p>

      <!-- Carousel: single rejected suggestion at a time -->
      <div v-if="currentRejectedSuggestion" class="p-3 bg-gray-50 border border-gray-200 rounded-lg">
        <div class="flex items-center gap-2 flex-wrap">
          <span
            class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
            :class="currentRejectedSuggestion.type === 'add_row' ? 'bg-blue-100 text-blue-800' : currentRejectedSuggestion.type === 'delete_row' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'"
          >
            {{ currentRejectedSuggestion.type === 'add_row' ? 'Add' : currentRejectedSuggestion.type === 'delete_row' ? 'Delete' : 'Edit' }}
          </span>
          <span
            v-if="currentRejectedSuggestion.source"
            class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600"
          >
            {{ currentRejectedSuggestion.source === 'software_detection' ? 'Software' : currentRejectedSuggestion.source === 'datasets_detection' ? 'Datasets' : currentRejectedSuggestion.source === 'materials_detection' ? 'Materials' : currentRejectedSuggestion.source === 'protocols_detection' ? 'Protocols' : currentRejectedSuggestion.source === 'pdf_analysis' ? 'PDF' : currentRejectedSuggestion.source }}
          </span>
          <span class="text-sm font-medium text-gray-900 truncate">{{ currentRejectedSuggestion.title }}</span>
        </div>
        <p class="text-sm text-gray-600 mt-1">
          <template v-if="currentRejectedSuggestion.type === 'edit' && currentRejectedSuggestion.data">
            {{ currentRejectedSuggestion.data.column }}: "<span class="text-red-600 line-through">{{ currentRejectedSuggestion.data.oldValue || '(empty)' }}</span>" → "<span class="text-gray-600">{{ currentRejectedSuggestion.data.newValue }}</span>"
          </template>
          <template v-else-if="currentRejectedSuggestion.type === 'add_row' && currentRejectedSuggestion.data">
            {{ currentRejectedSuggestion.data.resourceType }}: {{ currentRejectedSuggestion.data.resourceName }}
          </template>
          <template v-else>
            {{ currentRejectedSuggestion.description }}
          </template>
        </p>
        <p
          v-if="currentRejectedSuggestion.rejectionReason"
          class="text-xs text-gray-500 mt-2 italic"
        >
          Reason: {{ currentRejectedSuggestion.rejectionReason }}
        </p>
      </div>

      <!-- Navigation: arrows + dot indicators -->
      <div v-if="rejectedSuggestions.length > 1" class="flex items-center justify-center mt-3 space-x-3">
        <button
          :disabled="currentRejectedIndex === 0"
          class="p-1 rounded-full transition-colors"
          :class="currentRejectedIndex === 0 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'"
          @click="goToPrevRejected"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div class="flex items-center space-x-1.5">
          <button
            v-for="(suggestion, index) in rejectedSuggestions"
            :key="suggestion.id"
            class="w-2 h-2 rounded-full transition-colors"
            :class="index === currentRejectedIndex ? 'bg-primary-600' : 'bg-gray-300 hover:bg-gray-400'"
            :title="`Rejected suggestion ${index + 1}`"
            @click="goToRejected(index)"
          />
        </div>

        <button
          :disabled="currentRejectedIndex === rejectedSuggestions.length - 1"
          class="p-1 rounded-full transition-colors"
          :class="currentRejectedIndex === rejectedSuggestions.length - 1 ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'"
          @click="goToNextRejected"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>

    <!-- KRT Data Table -->
    <div class="card overflow-hidden">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-medium">
          {{ showDetails ? 'KRT Data with Changes' : 'Final KRT Data' }}
        </h2>
        <div class="flex items-center gap-4">
          <!-- Legend (only when details enabled) -->
          <div v-if="showDetails && hasChanges" class="flex items-center gap-3 text-xs flex-wrap">
            <span class="flex items-center gap-1">
              <span class="inline-block w-3 h-3 bg-green-100 border border-green-400 rounded"></span>
              Added
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-3 h-3 bg-blue-100 border border-blue-400 rounded"></span>
              Updated
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-3 h-3 bg-red-100 border border-red-400 rounded"></span>
              Deleted
            </span>
            <span class="legend-divider">|</span>
            <span
              class="source-tag source-tag-ai source-tag-clickable"
              :class="{ 'source-tag-hidden': hiddenSources.has('AI') }"
              title="Click to show/hide AI changes"
              @click="toggleSourceVisibility('AI')"
            >AI</span>
            <span
              class="source-tag source-tag-validation source-tag-clickable"
              :class="{ 'source-tag-hidden': hiddenSources.has('Val') }"
              title="Click to show/hide Validation changes"
              @click="toggleSourceVisibility('Val')"
            >Val</span>
            <span
              class="source-tag source-tag-manual source-tag-clickable"
              :class="{ 'source-tag-hidden': hiddenSources.has('User') }"
              title="Click to show/hide User changes"
              @click="toggleSourceVisibility('User')"
            >User</span>
          </div>
          <!-- Toggle -->
          <label v-if="hasChanges" class="toggle-switch">
            <span class="toggle-label">Show changes</span>
            <input v-model="showDetails" type="checkbox" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Filter Tabs -->
      <div class="tab-container mb-4">
        <button
          v-for="tab in tabGroups"
          :key="tab.key"
          class="tab-button"
          :class="{ 'tab-active': activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
          <span class="tab-label-badge">{{ getTabCount(tab.key) }}</span>
        </button>
      </div>

      <div class="table-container table-scroll-limited">
        <table class="krt-table">
          <thead>
            <tr>
              <th class="col-row-num">#</th>
              <th v-if="showDetails && hasChanges" class="col-status">Status</th>
              <th
                v-for="col in columns"
                :key="col.key"
                class="col-data"
              >
                {{ col.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in filteredCombinedRows"
              :key="`row-${row.id}`"
              :class="getRowClass(row)"
            >
              <td class="col-row-num">
                <span v-if="row.isDeleted" class="text-red-500" title="Deleted row">
                  &times;
                </span>
                <span v-else>{{ index + 1 }}</span>
              </td>
              <td v-if="showDetails && hasChanges" class="col-status">
                <div v-if="row.isDeleted" class="status-group" :title="`Deleted by ${row.deletedBy} on ${formatTime(row.deletedAt)}`">
                  <span class="status-badge status-deleted">Deleted</span>
                  <span class="source-tag" :class="getDeletedSourceTag(row).class">{{ getDeletedSourceTag(row).label }}</span>
                </div>
                <div v-else-if="isRowAdded(row)" class="status-group">
                  <span class="status-badge status-added">Added</span>
                  <span class="source-tag" :class="getAddedSourceTag(row).class">{{ getAddedSourceTag(row).label }}</span>
                </div>
                <div v-else-if="isRowUpdated(row)" class="status-group">
                  <span class="status-badge status-updated">Updated</span>
                  <span class="source-tag" :class="getUpdatedSourceTag(row).class">{{ getUpdatedSourceTag(row).label }}</span>
                </div>
                <span v-else class="status-badge status-existing">-</span>
              </td>
              <td
                v-for="col in columns"
                :key="col.key"
                :class="['col-data', getCellClass(row, col.key)]"
              >
                <div
                  class="cell-content"
                  :class="{ 'clickable': showDetails && !row.isDeleted && hasCellChange(row, col.key) }"
                  @click="showDetails && !row.isDeleted && hasCellChange(row, col.key) && openHistoryModal(row, col.key, col.label)"
                >
                  <span class="cell-text" :class="{ 'text-deleted': row.isDeleted }" :title="row[col.key]">
                    {{ row[col.key] || '-' }}
                  </span>

                  <!-- History indicator icon -->
                  <span
                    v-if="showDetails && !row.isDeleted && hasCellChange(row, col.key)"
                    class="history-icon"
                    title="Click to see change history"
                  >?</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="filteredCombinedRows.length === 0" class="text-center text-gray-500 py-8">
        {{ hiddenSources.size > 0 ? 'All rows hidden by active filters' : 'No data available' }}
      </p>
    </div>

    <!-- History Modal -->
    <div v-if="historyModal.show" class="modal-overlay" @click.self="closeHistoryModal">
      <div class="modal-container history-modal">
        <div class="modal-header">
          <h3>Change History - {{ historyModal.columnLabel }}</h3>
          <button class="modal-close" @click="closeHistoryModal">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <!-- Summary -->
          <div class="history-summary">
            <div class="summary-row">
              <span class="summary-label">Original Value:</span>
              <span class="summary-value original">{{ historyModal.cellData?.original || '(empty)' }}</span>
            </div>
            <div class="summary-row">
              <span class="summary-label">Final Value:</span>
              <span class="summary-value final">{{ historyModal.cellData?.final || '(empty)' }}</span>
            </div>
          </div>

          <!-- History List -->
          <div class="history-list">
            <h4>All Changes ({{ historyModal.cellData?.history?.length || 0 }})</h4>
            <div
              v-for="(change, idx) in historyModal.cellData?.history"
              :key="idx"
              class="history-card"
            >
              <div class="history-card-header">
                <span class="history-index">#{{ idx + 1 }}</span>
                <span :class="['source-badge', getChangeSourceClass(change)]">
                  {{ getChangeSource(change) }}
                </span>
              </div>
              <div class="history-card-meta">
                <span class="meta-user">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                  </svg>
                  {{ change.user?.name || 'Unknown' }}
                </span>
                <span class="meta-time">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {{ formatTime(change.createdAt) }}
                </span>
              </div>
              <div class="history-card-values">
                <div class="value-box old">
                  <span class="value-label">From:</span>
                  <span class="value-text">{{ change.oldValue || '(empty)' }}</span>
                </div>
                <div class="value-arrow">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </div>
                <div class="value-box new">
                  <span class="value-label">To:</span>
                  <span class="value-text">{{ change.newValue || '(empty)' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="closeHistoryModal">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Tab container */
.tab-container {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.tab-button {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #6b7280;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.15s;
}

.tab-button:hover {
  color: #374151;
  background: #f3f4f6;
}

.tab-button.tab-active {
  color: #2563eb;
  background: #eff6ff;
  border-color: #bfdbfe;
}

.tab-label-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.375rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #374151;
  background: #e5e7eb;
  border-radius: 9999px;
}

.tab-active .tab-label-badge {
  color: #1e40af;
  background: #dbeafe;
}

/* Table height limit - 10 lines max (~400px) */
.table-scroll-limited {
  max-height: 420px;
  overflow-y: auto;
}

/* Toggle switch */
.toggle-switch {
  display: flex;
  align-items: center;
  cursor: pointer;
  gap: 0.5rem;
}

.toggle-label {
  font-size: 0.875rem;
  color: #4b5563;
  white-space: nowrap;
}

.toggle-switch input {
  display: none;
}

.toggle-slider {
  position: relative;
  width: 2.5rem;
  height: 1.5rem;
  background: #d1d5db;
  border-radius: 9999px;
  transition: background 0.2s;
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 1.25rem;
  height: 1.25rem;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.toggle-switch input:checked + .toggle-slider {
  background: #3b82f6;
}

.toggle-switch input:checked + .toggle-slider::after {
  transform: translateX(1rem);
}

/* Stat cards */
.stat-card {
  padding: 1rem;
  border-radius: 0.5rem;
  text-align: center;
}

.stat-number {
  font-size: 1.5rem;
  font-weight: 700;
}

.stat-label {
  font-size: 0.75rem;
  color: #6b7280;
  margin-top: 0.25rem;
}

.stat-source-badge {
  display: block;
  font-size: 0.65rem;
  margin-top: 0.125rem;
}

.stat-ai-badge {
  color: #2563eb;
}

.stat-validation-badge {
  color: #7c3aed;
}

.stat-updated {
  background: #e0e7ff;
}
.stat-updated .stat-number {
  color: #4338ca;
}

.stat-added {
  background: #d1fae5;
}
.stat-added .stat-number {
  color: #059669;
}

.stat-deleted {
  background: #fee2e2;
}
.stat-deleted .stat-number {
  color: #dc2626;
}

/* Table styles */
.table-container {
  overflow-x: auto;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}

.krt-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.krt-table thead {
  background: #f9fafb;
}

.krt-table th {
  padding: 0.75rem;
  text-align: left;
  font-size: 0.75rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  border-bottom: 1px solid #e5e7eb;
  white-space: nowrap;
}

.krt-table td {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
}

.krt-table tbody tr:hover {
  background: #f9fafb;
}

.col-row-num {
  width: 50px;
  text-align: center;
  color: #6b7280;
}

.col-status {
  width: 110px;
  text-align: center;
}

.col-data {
  min-width: 80px;
  max-width: 180px;
}

/* Status badges */
.status-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
}

.status-existing {
  color: #9ca3af;
}

.status-added {
  background: #d1fae5;
  color: #065f46;
}

.status-updated {
  background: #dbeafe;
  color: #1e40af;
}

.status-deleted {
  background: #fee2e2;
  color: #991b1b;
}

/* Status group: badge + source tag */
.status-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}

/* Source tags (small badges showing origin) */
.source-tag {
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  border-radius: 9999px;
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
}

.source-tag-ai {
  background: #dbeafe;
  color: #1e40af;
}

.source-tag-validation {
  background: #ede9fe;
  color: #5b21b6;
}

.source-tag-manual {
  background: #fef3c7;
  color: #92400e;
}

.source-tag-clickable {
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-tag-clickable:hover {
  opacity: 0.8;
  transform: scale(1.1);
}

.source-tag-hidden {
  opacity: 0.35;
  text-decoration: line-through;
}

.legend-divider {
  color: #d1d5db;
  font-weight: 300;
}

/* Row highlighting */
.row-added {
  background: #ecfdf5 !important;
}

.row-added:hover {
  background: #d1fae5 !important;
}

.row-updated {
  background: #eff6ff !important;
}

.row-updated:hover {
  background: #dbeafe !important;
}

.row-deleted {
  background: #fef2f2 !important;
}

.row-deleted td {
  background: #fef2f2 !important;
}

.row-deleted:hover,
.row-deleted:hover td {
  background: #fee2e2 !important;
}

/* Cell content with overflow handling */
.cell-content {
  position: relative;
}

.cell-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.text-deleted {
  color: #9ca3af;
  text-decoration: line-through;
}

/* Cell highlighting (uniform blue for any change) */
.cell-changed {
  background: #dbeafe !important;
}

/* Cell with history - clickable */
.cell-content.clickable {
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
}

.cell-content.clickable:hover {
  opacity: 0.8;
}

.cell-content.clickable .cell-text {
  flex: 1;
  min-width: 0;
}

/* History indicator icon */
.history-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  font-size: 0.65rem;
  font-weight: 700;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 0.125rem;
}

/* Modal styles */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal-container {
  background: #fff;
  border-radius: 0.75rem;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.history-modal {
  width: 100%;
  max-width: 600px;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.modal-header h3 {
  font-size: 1.125rem;
  font-weight: 600;
  color: #111827;
  margin: 0;
}

.modal-close {
  padding: 0.5rem;
  color: #6b7280;
  background: none;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
}

.modal-close:hover {
  background: #f3f4f6;
  color: #111827;
}

.modal-close svg {
  width: 1.25rem;
  height: 1.25rem;
}

.modal-body {
  padding: 1.5rem;
  overflow-y: auto;
  flex: 1;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  padding: 1rem 1.5rem;
  border-top: 1px solid #e5e7eb;
}

/* History summary */
.history-summary {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.summary-row {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.summary-row:last-child {
  margin-bottom: 0;
}

.summary-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: #6b7280;
  min-width: 100px;
  flex-shrink: 0;
}

.summary-value {
  font-size: 0.875rem;
  word-break: break-word;
}

.summary-value.original {
  color: #dc2626;
  text-decoration: line-through;
}

.summary-value.final {
  color: #059669;
  font-weight: 500;
}

/* History list */
.history-list h4 {
  font-size: 0.875rem;
  font-weight: 600;
  color: #374151;
  margin: 0 0 1rem 0;
}

.history-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 0.75rem;
}

.history-card:last-child {
  margin-bottom: 0;
}

.history-card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.history-index {
  font-size: 0.75rem;
  font-weight: 600;
  color: #9ca3af;
}

.source-badge {
  padding: 0.25rem 0.625rem;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
}

.source-ai {
  background: #dbeafe;
  color: #1e40af;
}

.source-validation {
  background: #ede9fe;
  color: #5b21b6;
}

.source-manual {
  background: #fef3c7;
  color: #92400e;
}

.history-card-meta {
  display: flex;
  gap: 1.5rem;
  font-size: 0.8rem;
  color: #6b7280;
  margin-bottom: 0.75rem;
}

.meta-user, .meta-time {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.meta-user svg, .meta-time svg {
  width: 1rem;
  height: 1rem;
}

.history-card-values {
  display: flex;
  align-items: stretch;
  gap: 0.75rem;
  background: #f9fafb;
  border-radius: 0.375rem;
  padding: 0.75rem;
}

.value-box {
  flex: 1;
  min-width: 0;
}

.value-label {
  display: block;
  font-size: 0.7rem;
  font-weight: 500;
  color: #9ca3af;
  text-transform: uppercase;
  margin-bottom: 0.25rem;
}

.value-text {
  font-size: 0.875rem;
  word-break: break-word;
}

.value-box.old .value-text {
  color: #dc2626;
  text-decoration: line-through;
}

.value-box.new .value-text {
  color: #059669;
}

.value-arrow {
  display: flex;
  align-items: center;
  color: #9ca3af;
  flex-shrink: 0;
}

.value-arrow svg {
  width: 1.25rem;
  height: 1.25rem;
}
</style>
