<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useKRTStore } from '@/stores/krt.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useResourceTypesStore } from '@/stores/resourceTypes.store'
import api from '@/services/api'
import krtService from '@/services/krt.service'
import suggestionService from '@/services/suggestion.service'
import KRTCellEditModal from './KRTCellEditModal.vue'

const props = defineProps({
  submissionId: {
    type: String,
    required: true
  },
  readonly: {
    type: Boolean,
    default: false
  },
  showRevalidate: {
    type: Boolean,
    default: false
  },
  krtFileUrl: {
    type: String,
    default: ''
  },
  /** External tab control (for syncing with parent) */
  modelValue: {
    type: String,
    default: null
  },
  /**
   * Suggestion id currently displayed in the parent's AI-suggestions section.
   * The matching add_row row in the table gets a darker highlight so the
   * user can see which suggestion the detail panel is showing.
   */
  activeSuggestionId: {
    type: String,
    default: null
  }
})

const emit = defineEmits([
  'suggestion-accepted',
  'suggestion-rejected',
  'scroll-to-suggestions',
  'revalidate',
  'update:modelValue',
  'select-suggestion'
])

const krtStore = useKRTStore()
const notificationStore = useNotificationStore()
const resourceTypesStore = useResourceTypesStore()

const showAddRow = ref(false)
const showDownloadMenu = ref(false)
const downloading = ref(false)
const tableContainer = ref(null)
const activeTooltip = ref(null)
const activeTabTooltip = ref(null)
const searchQuery = ref('')
const activeCellTooltip = ref(null) // Format: "rowId-columnKey" for validation errors
const activeSuggestionTooltip = ref(null) // Format: "rowId-columnKey" for AI suggestions
const showEditModal = ref(false)
const modalCell = ref(null)
const modalValue = ref('')
const resourceTypes = ref([])

// ── Bulk-ops selection state ─────────────────────────────────────────
// Two parallel sets because suggestions and KRT rows take different
// actions (approve/reject vs cell edit). Each selection is exclusive in
// practice — the action bar resolves which action to expose based on
// which set is non-empty.
const selectedSuggestionIds = ref(new Set())
const selectedRowIds = ref(new Set())
const bulkSubmitting = ref(false)
const showBulkResourceTypeModal = ref(false)
const bulkResourceTypeValue = ref('')
const showBulkEditCellsModal = ref(false)
const bulkEditCellsColumn = ref('RESOURCE TYPE')
const bulkEditCellsValue = ref('')
const newRow = ref({
  resourceType: '',
  resourceName: '',
  source: '',
  identifier: '',
  newReuse: '',
  additionalInformation: ''
})

// Fetch resource types on mount
onMounted(async () => {
  try {
    const response = await api.get('/config/resource-types')
    resourceTypes.value = response.data.resourceTypes || []
  } catch (e) {
    console.warn('Failed to fetch resource types')
  }
  // Load resource type → category mapping for tab filtering
  try {
    await resourceTypesStore.fetchResourceTypeNames()
  } catch (e) {
    console.warn('Failed to fetch resource type categories')
  }
  document.addEventListener('click', handleClickOutsideDownload)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutsideDownload)
})

function handleClickOutsideDownload(e) {
  if (showDownloadMenu.value) {
    const wrapper = document.querySelector('.download-dropdown-wrapper')
    if (wrapper && !wrapper.contains(e.target)) {
      showDownloadMenu.value = false
    }
  }
}

const krtRows = computed(() => krtStore.rows)
const summary = computed(() => krtStore.summary)
const loading = computed(() => krtStore.loading)

const columns = [
  { key: 'RESOURCE TYPE', field: 'resource_type', label: 'Resource Type' },
  { key: 'RESOURCE NAME', field: 'resource_name', label: 'Resource Name' },
  { key: 'SOURCE', field: 'source', label: 'Source' },
  { key: 'IDENTIFIER', field: 'identifier', label: 'Identifier' },
  { key: 'NEW/REUSE', field: 'new_reuse', label: 'New/Reuse' },
  { key: 'ADDITIONAL INFORMATION', field: 'additional_information', label: 'Additional Info' }
]

// Tab definitions
const tabGroups = [
  { key: 'all', label: 'All' },
  { key: 'Datasets', label: 'Datasets' },
  { key: 'Software/code', label: 'Software/code' },
  { key: 'Protocols', label: 'Protocols' },
  { key: 'Lab Materials', label: 'Key Lab Materials' }
]

// Active tab (synced with modelValue if provided)
const activeTab = ref(props.modelValue || 'all')

// Sync activeTab with modelValue prop
watch(() => props.modelValue, (newVal) => {
  if (newVal && newVal !== activeTab.value) {
    activeTab.value = newVal
  }
})

// Column sorting state
const sortColumn = ref(null)
const sortDirection = ref('asc')

// Get group for a resource type (uses store data from DB)
function getResourceGroup(resourceType) {
  return resourceTypesStore.getTabGroup(resourceType)
}

/**
 * Source labels used in the merged-from pills (e.g. "SW + PDF").
 * Acts as a tiny lookup keyed on the detection source string.
 */
const SOURCE_LABEL = {
  software_detection: 'SW',
  pdf_analysis:       'PDF',
  datasets_detection: 'DS',
  materials_detection: 'MAT',
  protocols_detection: 'PROT',
  identifier_detection: 'ID'
}

/**
 * Return the unique detector sources that contributed to a suggestion. Reads
 * `mergedFrom` (post-consolidator) when available, else falls back to the
 * single legacy `source` field.
 */
function getContributingSources(suggestion) {
  if (Array.isArray(suggestion?.mergedFrom) && suggestion.mergedFrom.length > 0) {
    const seen = new Set()
    const out = []
    for (const entry of suggestion.mergedFrom) {
      const s = entry?.source
      if (s && !seen.has(s)) { seen.add(s); out.push(s) }
    }
    return out.length ? out : (suggestion.source ? [suggestion.source] : [])
  }
  return suggestion?.source ? [suggestion.source] : []
}

// Default sort: by tab group, then by resource type sort_order from DB.
// Ties are broken by the row's original insertion order — authors often
// arrange resources in a logical (not alphabetical) order, and we shouldn't
// reshuffle that. Backend already returns rows ordered by created_at ASC,
// and V8's Array.prototype.sort is stable since Node 12, so equal-keyed rows
// keep their original relative position automatically.
function defaultSort(a, b) {
  const groupA = resourceTypesStore.getGroupSortOrder(a['RESOURCE TYPE'])
  const groupB = resourceTypesStore.getGroupSortOrder(b['RESOURCE TYPE'])
  if (groupA !== groupB) return groupA - groupB
  const typeA = resourceTypesStore.getTypeSortOrder(a['RESOURCE TYPE'])
  const typeB = resourceTypesStore.getTypeSortOrder(b['RESOURCE TYPE'])
  return typeA - typeB
}

// Within-tab sort: resource type first (so all Antibodies sit together).
// Insertion order preserved within each type (stable sort, see above).
function withinTabSort(a, b) {
  const typeA = resourceTypesStore.getTypeSortOrder(a['RESOURCE TYPE'])
  const typeB = resourceTypesStore.getTypeSortOrder(b['RESOURCE TYPE'])
  return typeA - typeB
}

// Filtered rows based on active tab (with group + name ordering) + search
const filteredRows = computed(() => {
  let rows
  if (activeTab.value === 'all') {
    rows = [...krtRows.value].sort(defaultSort)
  } else {
    rows = krtRows.value
      .filter(row => getResourceGroup(row['RESOURCE TYPE']) === activeTab.value)
      .sort(withinTabSort)
  }

  // Apply search filter
  const query = searchQuery.value.trim().toLowerCase()
  if (query) {
    rows = rows.filter(row =>
      columns.some(col => (row[col.key] || '').toString().toLowerCase().includes(query))
    )
  }

  return rows
})

// Sorted + filtered rows (column sorting on top of tab filtering)
const sortedFilteredRows = computed(() => {
  if (!sortColumn.value) return filteredRows.value
  return [...filteredRows.value].sort((a, b) => {
    const valA = (a[sortColumn.value] || '').toString().toLowerCase()
    const valB = (b[sortColumn.value] || '').toString().toLowerCase()
    const cmp = valA.localeCompare(valB)
    return sortDirection.value === 'asc' ? cmp : -cmp
  })
})

// Toggle column sort: asc -> desc -> reset
function toggleSort(columnKey) {
  if (sortColumn.value === columnKey) {
    if (sortDirection.value === 'asc') {
      sortDirection.value = 'desc'
    } else {
      sortColumn.value = null
      sortDirection.value = 'asc'
    }
  } else {
    sortColumn.value = columnKey
    sortDirection.value = 'asc'
  }
}

// Reset sort when switching tabs
function switchTab(tabKey) {
  activeTab.value = tabKey
  sortColumn.value = null
  sortDirection.value = 'asc'
  // Emit for parent sync (v-model support)
  emit('update:modelValue', tabKey)
}

// Display summary: shows tab-specific or global counts
const displaySummary = computed(() => {
  if (activeTab.value === 'all') {
    return {
      rows: krtRows.value.length,
      errors: summary.value.totalErrors,
      warnings: summary.value.totalWarnings,
      suggestions: summary.value.totalSuggestions,
      tabLabel: null
    }
  }

  const tabRows = filteredRows.value
  const tabRowIds = new Set(tabRows.map(r => r.id))

  let errors = 0
  let warnings = 0
  for (const rowId of tabRowIds) {
    const rowErrors = krtStore.validationErrors[rowId] || []
    errors += rowErrors.filter(e => e.severity === 'error').length
    warnings += rowErrors.filter(e => e.severity === 'warning').length
  }

  let suggestions = 0
  for (const row of tabRows) {
    suggestions += getRowSuggestions(row.id).length
  }
  suggestions += filteredAddRowSuggestions.value.length

  const tabLabel = tabGroups.find(t => t.key === activeTab.value)?.label || null

  return {
    rows: tabRows.length,
    errors,
    warnings,
    suggestions,
    tabLabel
  }
})

// Count rows and pending suggestions per group for tab badges
const tabCounts = computed(() => {
  const pendingSuggestions = (krtStore.addRowSuggestions || []).filter(s => s.status === 'pending')

  const counts = {}
  for (const tab of tabGroups) {
    if (tab.key === 'all') {
      counts[tab.key] = {
        rows: krtRows.value.length,
        suggestions: pendingSuggestions.length,
        total: krtRows.value.length + pendingSuggestions.length
      }
    } else {
      const rows = krtRows.value.filter(row => getResourceGroup(row['RESOURCE TYPE']) === tab.key).length
      const suggestions = pendingSuggestions.filter(s => getResourceGroup(s.data?.resourceType) === tab.key).length
      counts[tab.key] = { rows, suggestions, total: rows + suggestions }
    }
  }
  return counts
})

// Row-level issues: issues that don't target a specific column
function getRowLevelErrors(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  return errors.filter(e => e.severity === 'error' && !e.column)
}

function getRowLevelWarnings(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  return errors.filter(e => e.severity === 'warning' && !e.column)
}

function hasRowLevelIssue(rowId) {
  return getRowLevelErrors(rowId).length > 0 || getRowLevelWarnings(rowId).length > 0
}

function getRowLevelIssueClass(rowId) {
  // Apply row styling based on ANY issues (row-level or cell-level)
  // Errors take priority over warnings, warnings over suggestions
  if (hasAnyError(rowId)) return 'row-error'
  if (hasAnyWarning(rowId)) return 'row-warning'
  if (hasRowSuggestion(rowId)) return 'row-suggestion'
  return ''
}

// Cell-level issues: issues that target a specific column
function getCellErrors(rowId, columnKey) {
  const errors = krtStore.validationErrors[rowId] || []
  return errors.filter(e => e.column === columnKey)
}

function hasCellIssue(rowId, columnKey) {
  return getCellErrors(rowId, columnKey).length > 0
}

function getCellIssueClass(rowId, columnKey) {
  const errors = getCellErrors(rowId, columnKey)
  if (errors.some(e => e.severity === 'error')) return 'cell-error'
  if (errors.some(e => e.severity === 'warning')) return 'cell-warning'
  return ''
}

// All row-level issues (for the row number tooltip)
function getRowLevelIssues(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  return errors.filter(e => !e.column)
}

// Check if row has any issue (row-level or cell-level) for row styling
function hasAnyIssue(rowId) {
  return (krtStore.validationErrors[rowId] || []).length > 0
}

// Get all issues for a row (both row-level and cell-level)
function getAllRowIssues(rowId) {
  return krtStore.validationErrors[rowId] || []
}

// Get summary of affected columns for errors
function getErrorColumnsSummary(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  const errorColumns = [...new Set(errors.filter(e => e.severity === 'error' && e.column).map(e => e.column))]
  return errorColumns
}

// Get summary of affected columns for warnings
function getWarningColumnsSummary(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  const warningColumns = [...new Set(errors.filter(e => e.severity === 'warning' && e.column).map(e => e.column))]
  return warningColumns
}

// Check if row has any error (row-level or cell-level)
function hasAnyError(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  return errors.some(e => e.severity === 'error')
}

// Check if row has any warning (row-level or cell-level)
function hasAnyWarning(rowId) {
  const errors = krtStore.validationErrors[rowId] || []
  return errors.some(e => e.severity === 'warning')
}

// Get the icon class based on all issues (errors take priority)
function getRowIssueIconClass(rowId) {
  if (hasAnyError(rowId)) return 'icon-error'
  if (hasAnyWarning(rowId)) return 'icon-warning'
  return ''
}

// Cell tooltip functions
function showCellTooltip(rowId, columnKey) {
  activeCellTooltip.value = `${rowId}-${columnKey}`
}

function hideCellTooltip() {
  activeCellTooltip.value = null
}

function isCellTooltipActive(rowId, columnKey) {
  return activeCellTooltip.value === `${rowId}-${columnKey}`
}

// Suggestion tooltip functions
function showSuggestionTooltip(rowId, columnKey) {
  activeSuggestionTooltip.value = `${rowId}-${columnKey}`
}

function hideSuggestionTooltip() {
  activeSuggestionTooltip.value = null
}

function isSuggestionTooltipActive(rowId, columnKey) {
  return activeSuggestionTooltip.value === `${rowId}-${columnKey}`
}

// Combined handler for cell hover - show appropriate tooltip
function handleCellMouseEnter(rowId, columnKey) {
  // Priority: validation errors first, then AI suggestions
  if (hasCellIssue(rowId, columnKey)) {
    showCellTooltip(rowId, columnKey)
  } else if (hasCellSuggestion(rowId, columnKey)) {
    showSuggestionTooltip(rowId, columnKey)
  }
}

function handleCellMouseLeave() {
  hideCellTooltip()
  hideSuggestionTooltip()
}

// AI Suggestions
function getCellSuggestion(rowId, columnKey) {
  return krtStore.getCellSuggestion(rowId, columnKey)
}

function hasCellSuggestion(rowId, columnKey) {
  return !!getCellSuggestion(rowId, columnKey)
}

function getRowSuggestions(rowId) {
  return krtStore.getRowSuggestions(rowId)
}

function hasRowSuggestion(rowId) {
  return getRowSuggestions(rowId).length > 0
}

/**
 * Unique detector sources across every pending edit suggestion attached
 * to this row. Drives the module badges rendered in the # cell so update
 * suggestions show the same origin chip as add suggestions.
 */
function getRowSuggestionSources(rowId) {
  const seen = new Set()
  const out = []
  for (const suggestion of getRowSuggestions(rowId)) {
    for (const src of getContributingSources(suggestion)) {
      if (!seen.has(src)) { seen.add(src); out.push(src) }
    }
  }
  return out
}

// Combined: has any issue OR suggestion
function hasAnyCellHighlight(rowId, columnKey) {
  return hasCellIssue(rowId, columnKey) || hasCellSuggestion(rowId, columnKey)
}

function hasAnyRowHighlight(rowId) {
  return hasAnyIssue(rowId) || hasRowSuggestion(rowId)
}

// Get cell class including suggestions
function getCellClass(rowId, columnKey) {
  const issueClass = getCellIssueClass(rowId, columnKey)
  if (issueClass) return issueClass
  if (hasCellSuggestion(rowId, columnKey)) return 'cell-suggestion'
  return ''
}

function startEdit(row, column, rowIndex) {
  if (props.readonly) return
  // Open modal for editing
  modalCell.value = {
    rowId: row.id,
    displayIndex: rowIndex + 1,
    column: column.key,
    columnLabel: column.label,
    field: column.field
  }

  // Get current value
  let initialValue = row[column.key] || ''

  // For RESOURCE TYPE, check if there's a suggestion and pre-select it
  if (column.key === 'RESOURCE TYPE') {
    const cellErrors = getCellErrors(row.id, column.key)
    const suggestionError = cellErrors.find(e => e.suggestion && e.suggestion.startsWith('Use "'))
    if (suggestionError) {
      // Extract the suggested value from 'Use "Protocols" instead'
      const match = suggestionError.suggestion.match(/Use "([^"]+)"/)
      if (match && match[1] && resourceTypes.value.includes(match[1])) {
        initialValue = match[1]
      }
    }
  }

  modalValue.value = initialValue
  showEditModal.value = true
}

async function saveModalEdit() {
  if (!modalCell.value) return

  try {
    await krtStore.updateCell(props.submissionId, modalCell.value.rowId, modalCell.value.field, modalValue.value)
    notificationStore.success('Cell updated')
    closeEditModal()
  } catch (error) {
    notificationStore.error('Failed to update cell')
  }
}

// Quick set "No identifier exists" for identifier cells
async function setQuickNoIdentifier(rowId, field) {
  try {
    await krtStore.updateCell(props.submissionId, rowId, field, 'No identifier exists')
    notificationStore.success('Set to "No identifier exists"')
  } catch (error) {
    notificationStore.error('Failed to update cell')
  }
}

// Quick set "Identifier pending" for identifier cells
async function setQuickIdentifierPending(rowId, field) {
  try {
    await krtStore.updateCell(props.submissionId, rowId, field, 'Identifier pending')
    notificationStore.success('Set to "Identifier pending"')
  } catch (error) {
    notificationStore.error('Failed to update cell')
  }
}

async function downloadKRT(format) {
  showDownloadMenu.value = false
  downloading.value = true
  try {
    const blob = await krtService.download(props.submissionId, format)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `krt_${props.submissionId}.${format}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (error) {
    notificationStore.error('Failed to download KRT file')
  } finally {
    downloading.value = false
  }
}

function closeEditModal() {
  showEditModal.value = false
  modalCell.value = null
  modalValue.value = ''
}

function getModalCellIssues() {
  if (!modalCell.value) return []
  return getCellErrors(modalCell.value.rowId, modalCell.value.column)
}


async function handleAddRow() {
  try {
    await krtStore.addRow(props.submissionId, {
      resourceType: newRow.value.resourceType,
      resourceName: newRow.value.resourceName,
      source: newRow.value.source,
      identifier: newRow.value.identifier,
      newReuse: newRow.value.newReuse,
      additionalInformation: newRow.value.additionalInformation
    })
    notificationStore.success('Row added')
    showAddRow.value = false
    resetNewRow()

    // Scroll to the newly added row (last by createdAt)
    await nextTick()
    const lastRow = krtRows.value[krtRows.value.length - 1]
    if (lastRow) {
      scrollToRow(lastRow.id)
    }
  } catch (error) {
    const message = error.response?.data?.error || error.message || 'Failed to add row'
    notificationStore.error(message)
  }
}

async function handleDeleteRow(rowId) {
  if (!confirm('Are you sure you want to delete this row?')) return

  try {
    await krtStore.deleteRow(props.submissionId, rowId)
    notificationStore.success('Row deleted')
  } catch (error) {
    notificationStore.error('Failed to delete row')
  }
}

function resetNewRow() {
  newRow.value = {
    resourceType: '',
    resourceName: '',
    source: '',
    identifier: '',
    newReuse: '',
    additionalInformation: ''
  }
}

function showTooltip(rowId) {
  activeTooltip.value = rowId
}

function hideTooltip() {
  activeTooltip.value = null
}

function getTooltipPosition(rowIndex) {
  return rowIndex < 3 ? 'below' : 'above'
}

// Get suggestion for the current modal cell
function getModalCellSuggestion() {
  if (!modalCell.value) return null
  return getCellSuggestion(modalCell.value.rowId, modalCell.value.column)
}

// Accept a suggestion - apply the change
async function acceptSuggestion(suggestion) {
  if (!suggestion) return

  try {
    // Apply the change via backend
    await suggestionService.approveSuggestion(props.submissionId, suggestion.id)

    // Update local store
    krtStore.updateSuggestionStatus(suggestion.id, 'approved')

    // Re-validate KRT (this also fetches updated data)
    await krtStore.validate(props.submissionId)

    notificationStore.success('Suggestion accepted')
    emit('suggestion-accepted', suggestion)
    closeEditModal()
  } catch (error) {
    notificationStore.error('Failed to accept suggestion')
  }
}

// Reject a suggestion (reason passed from modal)
async function rejectSuggestion(suggestion, reason = '') {
  if (!suggestion) return

  try {
    await suggestionService.rejectSuggestion(props.submissionId, suggestion.id, typeof reason === 'string' ? reason : '')

    // Update local store
    krtStore.updateSuggestionStatus(suggestion.id, 'rejected')

    notificationStore.info('Suggestion rejected')
    emit('suggestion-rejected', suggestion)
    closeEditModal()
  } catch (error) {
    notificationStore.error('Failed to reject suggestion')
  }
}

// Add row suggestions
const addRowSuggestions = computed(() => krtStore.addRowSuggestions)

// Filtered add-row suggestions based on the active tab, sorted alphabetically
// by resource name (case-insensitive). On the "all" tab we additionally group
// by resource-type group order so each group's suggestions stay together.
const filteredAddRowSuggestions = computed(() => {
  const list = activeTab.value === 'all'
    ? [...addRowSuggestions.value]
    : addRowSuggestions.value.filter(suggestion => {
        const resourceType = suggestion.data?.resourceType
        return getResourceGroup(resourceType) === activeTab.value
      })

  return list.sort((a, b) => {
    const nameA = (a.data?.resourceName || '').toLowerCase()
    const nameB = (b.data?.resourceName || '').toLowerCase()
    if (activeTab.value === 'all') {
      const groupA = resourceTypesStore.getGroupSortOrder(a.data?.resourceType)
      const groupB = resourceTypesStore.getGroupSortOrder(b.data?.resourceType)
      if (groupA !== groupB) return groupA - groupB
    }
    return nameA.localeCompare(nameB)
  })
})

// ── Bulk-ops helpers ──────────────────────────────────────────────
function isSuggestionSelected(id) {
  return selectedSuggestionIds.value.has(id)
}
function isRowSelected(id) {
  return selectedRowIds.value.has(id)
}
function toggleSuggestionSelection(id) {
  const next = new Set(selectedSuggestionIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedSuggestionIds.value = next
  // Suggestion and row selection are mutually exclusive — selecting a
  // suggestion clears any pending row selection so the action bar can show
  // an unambiguous set of bulk actions.
  if (next.size > 0) selectedRowIds.value = new Set()
}
function toggleRowSelection(id) {
  const next = new Set(selectedRowIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedRowIds.value = next
  if (next.size > 0) selectedSuggestionIds.value = new Set()
}
function clearBulkSelection() {
  selectedSuggestionIds.value = new Set()
  selectedRowIds.value = new Set()
}

const visibleSuggestionIds = computed(() => filteredAddRowSuggestions.value
  .filter(s => s.status === 'pending')
  .map(s => s.id))
const visibleRowIds = computed(() => sortedFilteredRows.value.map(r => r.id))

const allVisibleSuggestionsSelected = computed(() =>
  visibleSuggestionIds.value.length > 0 &&
  visibleSuggestionIds.value.every(id => selectedSuggestionIds.value.has(id))
)
const allVisibleRowsSelected = computed(() =>
  visibleRowIds.value.length > 0 &&
  visibleRowIds.value.every(id => selectedRowIds.value.has(id))
)

function toggleSelectAllVisibleSuggestions() {
  if (allVisibleSuggestionsSelected.value) {
    selectedSuggestionIds.value = new Set()
  } else {
    selectedSuggestionIds.value = new Set(visibleSuggestionIds.value)
    selectedRowIds.value = new Set()
  }
}

function toggleSelectAllVisibleRows() {
  if (allVisibleRowsSelected.value) {
    selectedRowIds.value = new Set()
  } else {
    selectedRowIds.value = new Set(visibleRowIds.value)
    selectedSuggestionIds.value = new Set()
  }
}

async function bulkApproveSelected(overrideType = null) {
  if (selectedSuggestionIds.value.size === 0) return
  bulkSubmitting.value = true
  try {
    // Build per-item payloads. Each suggestion can carry two kinds of edits:
    //   1. inline per-cell edits the user made on the suggestion row
    //   2. a bulk "force this Resource Type" override (when overrideType is set)
    // The Resource Type override wins over the inline edit so the bulk action
    // is predictable for the user; everything else flows from the inline edits.
    const items = Array.from(selectedSuggestionIds.value).map(id => {
      const suggestion = filteredAddRowSuggestions.value.find(s => s.id === id)
        || krtStore.addRowSuggestions?.find(s => s.id === id)
      const inlineDiff = suggestion ? diffSuggestionEdits(suggestion) : null
      const item = { suggestionId: id }
      const overrides = { ...(inlineDiff || {}) }
      if (overrideType) overrides.resourceType = overrideType
      if (Object.keys(overrides).length > 0) item.overrides = overrides
      return item
    })
    const res = await suggestionService.bulkApprove(props.submissionId, items)
    notificationStore.success(res.message || `${items.length} approved`)
    // Mirror per-item status into the store so the UI updates immediately
    // without waiting for a full refetch.
    for (const r of res.results || []) {
      if (r.status === 'approved') {
        krtStore.updateSuggestionStatus(r.suggestionId, 'approved')
        delete editorSuggestionEdits.value[r.suggestionId]
      }
    }
    clearBulkSelection()
    await krtStore.validate(props.submissionId)
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Bulk approve failed')
  } finally {
    bulkSubmitting.value = false
    showBulkResourceTypeModal.value = false
    bulkResourceTypeValue.value = ''
  }
}

async function bulkRejectSelected() {
  if (selectedSuggestionIds.value.size === 0) return
  bulkSubmitting.value = true
  try {
    const items = Array.from(selectedSuggestionIds.value).map(id => ({ suggestionId: id }))
    const res = await suggestionService.bulkReject(props.submissionId, items)
    notificationStore.info(res.message || `${items.length} rejected`)
    for (const r of res.results || []) {
      if (r.status === 'rejected') krtStore.updateSuggestionStatus(r.suggestionId, 'rejected')
    }
    clearBulkSelection()
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Bulk reject failed')
  } finally {
    bulkSubmitting.value = false
  }
}

function openBulkResourceTypeModal() {
  if (selectedSuggestionIds.value.size === 0) return
  bulkResourceTypeValue.value = ''
  showBulkResourceTypeModal.value = true
}
async function confirmBulkResourceType() {
  if (!bulkResourceTypeValue.value) return
  await bulkApproveSelected(bulkResourceTypeValue.value)
}

function openBulkEditCellsModal() {
  if (selectedRowIds.value.size === 0) return
  bulkEditCellsColumn.value = 'RESOURCE TYPE'
  bulkEditCellsValue.value = ''
  showBulkEditCellsModal.value = true
}

async function applyBulkEditCells() {
  if (selectedRowIds.value.size === 0) return
  bulkSubmitting.value = true
  try {
    const field = columnKeyToField[bulkEditCellsColumn.value]
    const updates = Array.from(selectedRowIds.value).map(rowId => ({
      rowId,
      column: field,
      value: bulkEditCellsValue.value
    }))
    await krtStore.batchUpdateCells(props.submissionId, updates)
    notificationStore.success(`Updated ${updates.length} row${updates.length > 1 ? 's' : ''}`)
    clearBulkSelection()
    await krtStore.validate(props.submissionId)
  } catch (err) {
    notificationStore.error(err.response?.data?.error || 'Bulk edit failed')
  } finally {
    bulkSubmitting.value = false
    showBulkEditCellsModal.value = false
  }
}

// Maps display column names → store field names used by batchUpdateCells.
const columnKeyToField = {
  'RESOURCE TYPE': 'resource_type',
  'RESOURCE NAME': 'resource_name',
  'SOURCE': 'source',
  'IDENTIFIER': 'identifier',
  'NEW/REUSE': 'new_reuse',
  'ADDITIONAL INFORMATION': 'additional_information'
}

// Combined rows + add-row suggestions in correct sort order
// Suggestions appear at the position they would occupy after being accepted
const interleavedAddSuggestions = computed(() => {
  const suggestions = filteredAddRowSuggestions.value
  if (suggestions.length === 0) return {}

  // Build a map: afterRowIndex -> [suggestions]
  // We determine where each suggestion should appear based on the sort order
  const rows = sortedFilteredRows.value
  const result = {} // key: row index (or -1 for "before first row"), value: array of suggestions

  for (const suggestion of suggestions) {
    const sugResourceType = suggestion.data?.resourceType || ''
    const sugResourceName = suggestion.data?.resourceName || ''
    const sugGroup = getResourceGroup(sugResourceType)
    const sugGroupOrder = resourceTypesStore.getGroupSortOrder(sugResourceType)

    // Find the position this suggestion would occupy
    let insertAfterIndex = -1
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowGroup = getResourceGroup(row['RESOURCE TYPE'])
      const rowGroupOrder = resourceTypesStore.getGroupSortOrder(row['RESOURCE TYPE'])
      const rowName = row['RESOURCE NAME'] || ''

      if (activeTab.value === 'all') {
        // Sort by group order, then name
        if (rowGroupOrder < sugGroupOrder) {
          insertAfterIndex = i
        } else if (rowGroupOrder === sugGroupOrder && rowName.localeCompare(sugResourceName) <= 0) {
          insertAfterIndex = i
        }
      } else {
        // Sort by name only within tab
        if (rowName.localeCompare(sugResourceName) <= 0) {
          insertAfterIndex = i
        }
      }
    }

    if (!result[insertAfterIndex]) result[insertAfterIndex] = []
    result[insertAfterIndex].push(suggestion)
  }

  return result
})

// Check if a row has a delete suggestion
function getDeleteSuggestion(rowId) {
  return krtStore.getDeleteSuggestion(rowId)
}

function hasDeleteSuggestion(rowId) {
  return !!getDeleteSuggestion(rowId)
}

// ── Per-suggestion inline edits ──────────────────────────────────────
//
// Each add_row suggestion in the editor table is fully editable: the user
// can adjust any cell before clicking Accept. The edits live here keyed by
// suggestion id, seeded from the AI's proposed values so v-model on the
// row's inputs has a stable target.
const editorSuggestionEdits = ref({})

// Seed entries eagerly whenever the suggestion list changes, so v-model
// has somewhere to write before the user touches a cell. Lazy seeding (on
// first focus) would require the input's binding target to exist first.
watch(() => krtStore.addRowSuggestions, (list) => {
  if (!Array.isArray(list)) return
  for (const s of list) {
    if (s?.type === 'add_row' && s?.status === 'pending') {
      ensureSuggestionEdit(s)
    }
  }
}, { immediate: true, deep: true })

function ensureSuggestionEdit(suggestion) {
  if (!suggestion || suggestion.type !== 'add_row') return null
  let entry = editorSuggestionEdits.value[suggestion.id]
  if (!entry) {
    entry = {
      resourceType:          suggestion.data?.resourceType || '',
      resourceName:          suggestion.data?.resourceName || '',
      source:                suggestion.data?.source || '',
      identifier:            suggestion.data?.identifier || '',
      newReuse:              suggestion.data?.newReuse || '',
      additionalInformation: suggestion.data?.additionalInformation || ''
    }
    editorSuggestionEdits.value[suggestion.id] = entry
  }
  return entry
}

function suggestionCell(suggestion, field) {
  return ensureSuggestionEdit(suggestion)?.[field] ?? ''
}

function setSuggestionCell(suggestion, field, value) {
  const entry = ensureSuggestionEdit(suggestion)
  if (entry) entry[field] = value
}

/**
 * Diff the user's edits against the AI's proposed values. Returns only the
 * keys that changed, or null if nothing was touched. The backend's approve
 * endpoint falls back to AI values for any field not in `overrides`.
 */
function diffSuggestionEdits(suggestion) {
  const local = editorSuggestionEdits.value[suggestion.id]
  if (!local) return null
  const original = suggestion.data || {}
  const diff = {}
  for (const key of Object.keys(local)) {
    const userVal = (local[key] ?? '').toString()
    const aiVal = (original[key] ?? '').toString()
    if (userVal !== aiVal) diff[key] = userVal
  }
  return Object.keys(diff).length > 0 ? diff : null
}

// Accept an add_row suggestion, applying any inline edits as overrides.
async function acceptAddRowSuggestion(suggestion) {
  if (!suggestion) return

  try {
    const overrides = diffSuggestionEdits(suggestion)
    await suggestionService.approveSuggestion(props.submissionId, suggestion.id, null, overrides)
    krtStore.updateSuggestionStatus(suggestion.id, 'approved')
    await krtStore.fetchKRT(props.submissionId)
    // Re-validate to catch any issues with the new row (e.g., missing IDENTIFIER)
    await krtStore.validate(props.submissionId)
    notificationStore.success(overrides ? 'Row added with your edits' : 'Row added')
    emit('suggestion-accepted', suggestion)
    // Drop the per-suggestion edit entry — it's no longer pending.
    delete editorSuggestionEdits.value[suggestion.id]

    // Scroll to the newly added row
    await nextTick()
    const lastRow = krtRows.value[krtRows.value.length - 1]
    if (lastRow) {
      scrollToRow(lastRow.id)
    }
  } catch (error) {
    const message = error.response?.data?.error || error.message || 'Failed to add row'
    notificationStore.error(message)
  }
}

// Reject modal state
const showRejectModal = ref(false)
const rejectingSuggestion = ref(null)
const rejectReasonText = ref('')

function openRejectModal(suggestion) {
  rejectingSuggestion.value = suggestion
  rejectReasonText.value = ''
  showRejectModal.value = true
}

function cancelRejectModal() {
  showRejectModal.value = false
  rejectingSuggestion.value = null
}

async function confirmRejectModal() {
  if (!rejectingSuggestion.value) return
  const suggestion = rejectingSuggestion.value
  const reason = rejectReasonText.value.trim()
  showRejectModal.value = false
  rejectingSuggestion.value = null

  try {
    await suggestionService.rejectSuggestion(props.submissionId, suggestion.id, reason)
    krtStore.updateSuggestionStatus(suggestion.id, 'rejected')
    notificationStore.info('Suggestion rejected')
    emit('suggestion-rejected', suggestion)
  } catch (error) {
    notificationStore.error('Failed to reject suggestion')
  }
}

// Belt-and-suspenders: any time the modal hides (cancel / confirm / overlay
// click / programmatic dismissal), wipe the textarea state. Previously each
// dismissal path reset the text individually, which let a value sometimes
// leak to the next suggestion when a path was missed. Centralising the
// reset on the close event guarantees we never carry state across openings.
watch(showRejectModal, (visible) => {
  if (!visible) {
    rejectReasonText.value = ''
    rejectingSuggestion.value = null
  }
})

// Reject an add_row suggestion (opens modal)
function rejectAddRowSuggestion(suggestion) {
  if (!suggestion) return
  openRejectModal(suggestion)
}

// Accept a delete suggestion (delete the row)
async function acceptDeleteSuggestion(suggestion) {
  if (!suggestion) return

  try {
    await suggestionService.approveSuggestion(props.submissionId, suggestion.id)
    krtStore.updateSuggestionStatus(suggestion.id, 'approved')
    await krtStore.fetchKRT(props.submissionId)
    // Re-validate after deletion
    await krtStore.validate(props.submissionId)
    notificationStore.success('Row deleted')
    emit('suggestion-accepted', suggestion)
  } catch (error) {
    notificationStore.error('Failed to delete row')
  }
}

// Reject a delete suggestion (opens modal)
function rejectDeleteSuggestion(suggestion) {
  if (!suggestion) return
  openRejectModal(suggestion)
}

// Scroll to a specific row in the table (handles both vertical and horizontal scrolling)
function scrollToRow(rowId, columnKey = null) {
  if (!tableContainer.value) return

  const row = tableContainer.value.querySelector(`tr[data-row-id="${rowId}"]`)
  if (row) {
    // Get the scroll container
    const scrollContainer = tableContainer.value.querySelector('.table-scroll')
    if (!scrollContainer) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else {
      // Calculate vertical scroll position to center the row
      const rowRect = row.getBoundingClientRect()
      const containerRect = scrollContainer.getBoundingClientRect()
      const targetScrollTop = scrollContainer.scrollTop + (rowRect.top - containerRect.top) - (containerRect.height / 2) + (rowRect.height / 2)

      // If a column is specified, also scroll horizontally to center the cell
      if (columnKey) {
        const cell = row.querySelector(`td[data-column-key="${columnKey}"]`)
        if (cell) {
          const cellRect = cell.getBoundingClientRect()
          const targetScrollLeft = scrollContainer.scrollLeft + (cellRect.left - containerRect.left) - (containerRect.width / 2) + (cellRect.width / 2)
          scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), left: Math.max(0, targetScrollLeft), behavior: 'smooth' })
        } else {
          scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
        }
      } else {
        scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
      }
    }

    // Briefly highlight the row
    row.classList.add('highlight-flash')
    setTimeout(() => row.classList.remove('highlight-flash'), 2000)
  }
}

// Track current scroll position for cycling through errors/warnings/suggestions
const currentErrorIndex = ref(-1)
const currentWarningIndex = ref(-1)
const currentSuggestionScrollIndex = ref(-1)

// Reset scroll indices when validation data changes
watch(() => krtStore.validationErrors, () => {
  currentErrorIndex.value = -1
  currentWarningIndex.value = -1
}, { deep: true })

// Scroll to next error in visible/display order (cycles through all errors)
function scrollToFirstError() {
  const validationErrors = krtStore.validationErrors
  const errorRows = sortedFilteredRows.value.filter(row => {
    const errors = validationErrors[row.id] || []
    return errors.some(e => e.severity === 'error')
  })
  if (errorRows.length === 0) return

  // Advance to next error (wraps around)
  currentErrorIndex.value = (currentErrorIndex.value + 1) % errorRows.length
  const row = errorRows[currentErrorIndex.value]
  // Find the first error column to center on it
  const rowErrors = validationErrors[row.id] || []
  const firstErrorWithCol = rowErrors.find(e => e.severity === 'error' && e.column)
  scrollToRow(row.id, firstErrorWithCol?.column || null)
}

// Scroll to next warning in visible/display order (cycles through all warnings)
function scrollToFirstWarning() {
  const validationErrors = krtStore.validationErrors
  const warningRows = sortedFilteredRows.value.filter(row => {
    const errors = validationErrors[row.id] || []
    return errors.some(e => e.severity === 'warning')
  })
  if (warningRows.length === 0) return

  currentWarningIndex.value = (currentWarningIndex.value + 1) % warningRows.length
  const row = warningRows[currentWarningIndex.value]
  // Find the first warning column to center on it
  const rowErrors = validationErrors[row.id] || []
  const firstWarningWithCol = rowErrors.find(e => e.severity === 'warning' && e.column)
  scrollToRow(row.id, firstWarningWithCol?.column || null)
}

// Scroll to next suggestion in visible/display order (cycles through edit and add-row suggestions)
function scrollToFirstSuggestion() {
  // Collect all suggestion targets: edit suggestions (by row id) and add-row suggestions (by suggestion id)
  const targets = []

  for (const row of sortedFilteredRows.value) {
    if (hasRowSuggestion(row.id)) {
      targets.push({ type: 'row', id: row.id })
    }
  }

  for (const suggestion of filteredAddRowSuggestions.value) {
    targets.push({ type: 'suggestion', id: suggestion.id })
  }

  if (targets.length === 0) return

  currentSuggestionScrollIndex.value = (currentSuggestionScrollIndex.value + 1) % targets.length
  const target = targets[currentSuggestionScrollIndex.value]

  if (target.type === 'row') {
    scrollToRow(target.id)
  } else {
    scrollToSuggestionRow(target.id)
  }
}

// Scroll to an add-row suggestion by its suggestion ID
function scrollToSuggestionRow(suggestionId) {
  if (!tableContainer.value) return

  const row = tableContainer.value.querySelector(`tr[data-suggestion-id="${suggestionId}"]`)
  if (row) {
    const scrollContainer = tableContainer.value.querySelector('.table-scroll')
    if (!scrollContainer) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else {
      const rowRect = row.getBoundingClientRect()
      const containerRect = scrollContainer.getBoundingClientRect()
      const targetScrollTop = scrollContainer.scrollTop + (rowRect.top - containerRect.top) - (containerRect.height / 2) + (rowRect.height / 2)
      scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
    }

    row.classList.add('highlight-flash')
    setTimeout(() => row.classList.remove('highlight-flash'), 2000)
  }
}

// Expose methods for parent components
defineExpose({
  scrollToRow,
  scrollToSuggestionRow
})
</script>

<template>
  <div class="krt-editor">
    <!-- Summary Bar -->
    <div class="summary-bar">
      <div class="stats">
        <div class="stat">
          <span class="stat-value">{{ displaySummary.rows }}</span>
          <span class="stat-label">rows</span>
        </div>
        <div
          class="stat"
          :class="{ 'stat-clickable': displaySummary.errors > 0 }"
          :title="displaySummary.errors > 0 ? 'Click to go to first error' : ''"
          @click="displaySummary.errors > 0 && scrollToFirstError()"
        >
          <span class="stat-value stat-error">{{ displaySummary.errors }}</span>
          <span class="stat-label">errors</span>
        </div>
        <div
          class="stat"
          :class="{ 'stat-clickable': displaySummary.warnings > 0 }"
          :title="displaySummary.warnings > 0 ? 'Click to go to first warning' : ''"
          @click="displaySummary.warnings > 0 && scrollToFirstWarning()"
        >
          <span class="stat-value stat-warning">{{ displaySummary.warnings }}</span>
          <span class="stat-label">warnings</span>
        </div>
        <div
          v-if="displaySummary.suggestions > 0"
          class="stat stat-clickable"
          title="Click to go to first suggestion"
          @click="scrollToFirstSuggestion()"
        >
          <span class="stat-value stat-suggestion">{{ displaySummary.suggestions }}</span>
          <span class="stat-label">suggestions</span>
        </div>
        <span v-if="displaySummary.tabLabel" class="tab-label-badge">({{ displaySummary.tabLabel }})</span>
      </div>
      <div class="flex items-center space-x-2">
        <!-- Download KRT -->
        <div class="download-dropdown-wrapper">
          <button
            :disabled="downloading"
            class="btn-secondary text-sm inline-flex items-center"
            title="Download KRT data"
            @click="showDownloadMenu = !showDownloadMenu"
          >
            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {{ downloading ? 'Downloading...' : 'Download' }}
            <svg class="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <div v-if="showDownloadMenu" class="download-dropdown-menu">
            <button class="download-dropdown-item" @click="downloadKRT('csv')">
              <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Download CSV
            </button>
            <button class="download-dropdown-item" @click="downloadKRT('xlsx')">
              <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Download Excel
            </button>
          </div>
        </div>
        <!-- Re-validate -->
        <button
          v-if="showRevalidate && !readonly"
          :disabled="loading"
          class="btn-secondary text-sm inline-flex items-center"
          title="Re-validate KRT"
          @click="emit('revalidate')"
        >
          <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span v-if="loading">Validating...</span>
          <span v-else>Re-validate</span>
        </button>
        <!-- Add Row -->
        <button
          v-if="!readonly"
          class="btn-secondary text-sm inline-flex items-center"
          :title="showAddRow ? 'Cancel adding row' : 'Add a new row'"
          @click="showAddRow = !showAddRow"
        >
          <svg v-if="!showAddRow" class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <svg v-else class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          {{ showAddRow ? 'Cancel' : 'Add Row' }}
        </button>
      </div>
    </div>

    <!-- Add Row Form -->
    <div v-if="showAddRow && !readonly" class="add-row-form">
      <h3 class="form-title">Add New Row</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>Resource Type</label>
          <select v-model="newRow.resourceType">
            <option value="">Select type...</option>
            <option v-for="type in resourceTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </div>
        <div class="form-field">
          <label>Resource Name</label>
          <input v-model="newRow.resourceName" type="text" placeholder="Resource name" />
        </div>
        <div class="form-field">
          <label>Source</label>
          <input v-model="newRow.source" type="text" placeholder="e.g., Cell Signaling" />
        </div>
        <div class="form-field">
          <label>Identifier</label>
          <input v-model="newRow.identifier" type="text" placeholder="e.g., RRID:AB_123" />
        </div>
        <div class="form-field">
          <label>New/Reuse</label>
          <select v-model="newRow.newReuse">
            <option value="">Select...</option>
            <option value="new">new</option>
            <option value="reuse">reuse</option>
          </select>
        </div>
        <div class="form-field">
          <label>Additional Info</label>
          <input v-model="newRow.additionalInformation" type="text" placeholder="Optional" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary text-sm" @click="handleAddRow">Add Row</button>
      </div>
    </div>

    <!-- Resource Type Tabs + Search -->
    <div class="tabs-container">
      <div class="tabs">
        <button
          v-for="tab in tabGroups"
          :key="tab.key"
          :class="['tab', { 'tab-active': activeTab === tab.key }]"
          style="position: relative;"
          @click="switchTab(tab.key)"
          @mouseenter="activeTabTooltip = tab.key"
          @mouseleave="activeTabTooltip = null"
        >
          {{ tab.label }}
          <span class="tab-count">{{ tabCounts[tab.key]?.rows || 0 }}</span>
          <!-- Custom tooltip -->
          <div v-if="activeTabTooltip === tab.key" class="tooltip below" style="left: 50%; transform: translateX(-50%); width: auto; min-width: 160px;">
            <div class="tooltip-content" style="white-space: nowrap;">
              <div class="tooltip-item">
                <span class="tooltip-dot" style="background: #6b7280;"></span>
                <span>{{ tabCounts[tab.key]?.rows || 0 }} row{{ tabCounts[tab.key]?.rows !== 1 ? 's' : '' }}</span>
              </div>
              <div class="tooltip-item">
                <span class="tooltip-dot" style="background: #3b82f6;"></span>
                <span>{{ tabCounts[tab.key]?.suggestions || 0 }} suggestion{{ tabCounts[tab.key]?.suggestions !== 1 ? 's' : '' }}</span>
              </div>
            </div>
          </div>
        </button>
      </div>
      <div class="search-wrapper">
        <svg class="search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="Search..."
        />
        <button
          v-if="searchQuery"
          class="search-clear"
          title="Clear search"
          @click="searchQuery = ''"
        >
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Empty state for filtered view or no rows (hide if there are add-row suggestions to display) -->
    <div v-if="sortedFilteredRows.length === 0 && filteredAddRowSuggestions.length === 0" class="empty-filtered">
      <p v-if="!krtRows.length">No resources in this KRT yet. Use the "Add Row" button to get started.</p>
      <p v-else-if="searchQuery">No results matching "{{ searchQuery }}".</p>
      <p v-else>No {{ tabGroups.find(t => t.key === activeTab)?.label }} resources in this KRT.</p>
    </div>

    <!-- Bulk action bar — appears when the user selects ≥1 row or suggestion.
         Suggestion + KRT-row selections are mutually exclusive, so the bar
         shows different actions depending on what's selected. -->
    <div v-if="!readonly && (selectedSuggestionIds.size > 0 || selectedRowIds.size > 0)" class="bulk-action-bar">
      <span class="bulk-action-count">
        {{ selectedSuggestionIds.size > 0 ? selectedSuggestionIds.size : selectedRowIds.size }}
        {{ selectedSuggestionIds.size > 0 ? 'suggestion' : 'row' }}{{ (selectedSuggestionIds.size > 0 ? selectedSuggestionIds.size : selectedRowIds.size) > 1 ? 's' : '' }} selected
      </span>
      <div class="bulk-action-buttons">
        <template v-if="selectedSuggestionIds.size > 0">
          <button class="btn-bulk btn-bulk-primary" :disabled="bulkSubmitting" @click="bulkApproveSelected()">
            <span v-if="bulkSubmitting">Working…</span>
            <span v-else>Approve selected</span>
          </button>
          <button class="btn-bulk" :disabled="bulkSubmitting" @click="openBulkResourceTypeModal">Approve with Resource Type…</button>
          <button class="btn-bulk btn-bulk-danger" :disabled="bulkSubmitting" @click="bulkRejectSelected">Reject selected</button>
        </template>
        <template v-else>
          <button class="btn-bulk btn-bulk-primary" :disabled="bulkSubmitting" @click="openBulkEditCellsModal">Edit column…</button>
        </template>
        <button class="btn-bulk btn-bulk-ghost" @click="clearBulkSelection">Clear</button>
      </div>
    </div>

    <!-- Table Container -->
    <div v-if="sortedFilteredRows.length || filteredAddRowSuggestions.length" ref="tableContainer" class="table-container">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th v-if="!readonly" class="col-bulk-check">
                <input
                  type="checkbox"
                  class="bulk-check"
                  :checked="visibleSuggestionIds.length > 0 ? allVisibleSuggestionsSelected : allVisibleRowsSelected"
                  :title="visibleSuggestionIds.length > 0 ? 'Select all visible suggestions' : 'Select all visible rows'"
                  @click.stop="visibleSuggestionIds.length > 0 ? toggleSelectAllVisibleSuggestions() : toggleSelectAllVisibleRows()"
                />
              </th>
              <th class="col-row-num">
                <span class="th-content">#</span>
              </th>
              <th
                v-for="col in columns"
                :key="col.key"
                class="col-data col-sortable"
                @click="toggleSort(col.key)"
              >
                <span class="th-content">
                  {{ col.label }}
                  <svg v-if="sortColumn === col.key && sortDirection === 'asc'" class="sort-icon" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 4l4 5H4l4-5z" />
                  </svg>
                  <svg v-else-if="sortColumn === col.key && sortDirection === 'desc'" class="sort-icon" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 12l-4-5h8l-4 5z" />
                  </svg>
                  <svg v-else class="sort-icon sort-icon-idle" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 4l3 4H5l3-4zM8 12l-3-4h6l-3 4z" />
                  </svg>
                </span>
              </th>
              <th v-if="!readonly" class="col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            <!-- Suggestions that should appear before the first row -->
            <tr
              v-for="suggestion in (interleavedAddSuggestions[-1] || [])"
              :key="'add-' + suggestion.id"
              class="add-row-suggestion"
              :class="{ 'add-row-suggestion-active': suggestion.id === activeSuggestionId }"
              :data-suggestion-id="suggestion.id"
              @click="emit('select-suggestion', suggestion.id)"
            >
              <td v-if="!readonly" class="col-bulk-check" @click.stop>
                <input
                  type="checkbox"
                  class="bulk-check"
                  :disabled="suggestion.status !== 'pending'"
                  :checked="isSuggestionSelected(suggestion.id)"
                  @click.stop="toggleSuggestionSelection(suggestion.id)"
                />
              </td>
              <td :class="['col-row-num', 'add-row-num', { 'tooltip-active': activeTooltip === suggestion.id }]">
                <div class="row-num-content">
                  <svg class="add-icon-svg" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clip-rule="evenodd" />
                  </svg>
                  <!-- Module badge(s) live in the # cell so origin column lines
                       up across ADD and UPDATE suggestions. Order mirrors the
                       edit-row pattern: <number/+> <badge> <info>. -->
                  <span
                    v-for="src in getContributingSources(suggestion)"
                    :key="src"
                    class="suggestion-source-badge"
                    :class="'source-' + src"
                  >{{ SOURCE_LABEL[src] || src }}</span>
                  <!-- Same info indicator + tooltip the edit suggestions show
                       on existing rows, mirrored here so every suggestion has
                       the same hover-for-details affordance. -->
                  <div
                    class="issue-indicator"
                    @mouseenter.stop="showTooltip(suggestion.id)"
                    @mouseleave="hideTooltip"
                  >
                    <svg class="issue-icon icon-suggestion" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
                    </svg>
                    <div v-if="activeTooltip === suggestion.id" class="tooltip below">
                      <div class="tooltip-content tooltip-suggestion-content">
                        <div class="tooltip-item">
                          <span class="tooltip-dot dot-suggestion"></span>
                          <div class="tooltip-text">
                            <div class="tooltip-column">Add {{ suggestion.data?.resourceType || 'row' }}</div>
                            <div class="tooltip-message">{{ suggestion.title }}</div>
                            <div v-if="suggestion.detail" class="tooltip-message">{{ suggestion.detail }}</div>
                            <div class="tooltip-suggestion-hint">Accept (✓) or reject (✗) on the right</div>
                          </div>
                        </div>
                      </div>
                      <div class="tooltip-arrow tooltip-arrow-suggestion"></div>
                    </div>
                  </div>
                </div>
              </td>
              <!-- RESOURCE TYPE: editable dropdown for pending suggestions. -->
              <td class="col-data add-row-cell" @click.stop>
                <div class="add-row-type-cell">
                  <select
                    v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                    v-model="editorSuggestionEdits[suggestion.id].resourceType"
                    class="suggestion-inline-input"
                    title="Resource Type"
                  >
                    <option v-for="name in resourceTypesStore.resourceTypeNames" :key="name" :value="name">{{ name }}</option>
                  </select>
                  <span v-else class="cell-display">{{ suggestion.data?.resourceType || '' }}</span>
                  <span v-if="suggestion.existsInKRT === 'exact'" class="suggestion-source-badge source-in-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Already in KRT: ${suggestion.matchedKRTRow.resourceName}` : ''">In KRT</span>
                  <span v-else-if="suggestion.existsInKRT === 'update'" class="suggestion-source-badge source-update-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Update existing: ${suggestion.matchedKRTRow.resourceName}` : ''">Update</span>
                </div>
              </td>
              <!-- RESOURCE NAME -->
              <td class="col-data add-row-cell" @click.stop>
                <input
                  v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                  v-model="editorSuggestionEdits[suggestion.id].resourceName"
                  type="text"
                  class="suggestion-inline-input"
                  title="Resource Name"
                />
                <div v-else class="cell-display" :title="suggestion.data?.resourceName || ''">{{ suggestion.data?.resourceName || '' }}</div>
              </td>
              <!-- SOURCE -->
              <td class="col-data add-row-cell" @click.stop>
                <input
                  v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                  v-model="editorSuggestionEdits[suggestion.id].source"
                  type="text"
                  class="suggestion-inline-input"
                  title="Source"
                />
                <div v-else class="cell-display" :title="suggestion.data?.source || ''">{{ suggestion.data?.source || '' }}</div>
              </td>
              <!-- IDENTIFIER -->
              <td class="col-data add-row-cell" @click.stop>
                <input
                  v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                  v-model="editorSuggestionEdits[suggestion.id].identifier"
                  type="text"
                  class="suggestion-inline-input"
                  title="Identifier"
                />
                <div v-else class="cell-display" :title="suggestion.data?.identifier || ''">{{ suggestion.data?.identifier || '' }}</div>
              </td>
              <!-- NEW/REUSE -->
              <td class="col-data add-row-cell" @click.stop>
                <select
                  v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                  v-model="editorSuggestionEdits[suggestion.id].newReuse"
                  class="suggestion-inline-input"
                  title="New/Reuse"
                >
                  <option value="">—</option>
                  <option value="new">new</option>
                  <option value="reuse">reuse</option>
                </select>
                <span v-else>{{ suggestion.data?.newReuse || '' }}</span>
              </td>
              <!-- ADDITIONAL INFORMATION -->
              <td class="col-data add-row-cell" @click.stop>
                <input
                  v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                  v-model="editorSuggestionEdits[suggestion.id].additionalInformation"
                  type="text"
                  class="suggestion-inline-input"
                  title="Additional Information"
                />
                <div v-else class="cell-display" :title="suggestion.data?.additionalInformation || ''">{{ suggestion.data?.additionalInformation || '' }}</div>
              </td>
              <td v-if="!readonly" class="col-actions add-row-actions">
                <div class="add-row-buttons">
                  <button v-if="suggestion.existsInKRT !== 'exact'" class="btn-accept-add" :title="suggestion.existsInKRT === 'update' ? 'Accept - Update existing row' : 'Accept - Add this row'" @click.stop="acceptAddRowSuggestion(suggestion)">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                  </button>
                  <button class="btn-reject-add" title="Reject suggestion" @click.stop="rejectAddRowSuggestion(suggestion)">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              </td>
            </tr>
            <template
              v-for="(row, rowIndex) in sortedFilteredRows"
              :key="row.id"
            >
              <tr
                :data-row-id="row.id"
                :class="getRowLevelIssueClass(row.id)"
              >
                <td v-if="!readonly" class="col-bulk-check" @click.stop>
                  <input
                    type="checkbox"
                    class="bulk-check"
                    :checked="isRowSelected(row.id)"
                    @click.stop="toggleRowSelection(row.id)"
                  />
                </td>
                <!-- Row Number -->
                <td :class="['col-row-num', { 'tooltip-active': activeTooltip === row.id }]">
                  <div class="row-num-content">
                    <span class="row-num-label">{{ rowIndex + 1 }}</span>
                    <!-- Module badges for any update suggestions on this row.
                         Same chips that ADD suggestions show in the # cell,
                         so the origin column is consistent across both. -->
                    <span
                      v-for="src in getRowSuggestionSources(row.id)"
                      :key="src"
                      class="suggestion-source-badge"
                      :class="'source-' + src"
                    >{{ SOURCE_LABEL[src] || src }}</span>
                    <!-- Suggestion indicator -->
                    <div
                      v-if="hasRowSuggestion(row.id) && !hasAnyIssue(row.id)"
                      class="issue-indicator"
                      @mouseenter="showTooltip(row.id)"
                      @mouseleave="hideTooltip"
                    >
                      <svg class="issue-icon icon-suggestion" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
                      </svg>
                      <!-- Suggestion Tooltip -->
                      <div
                        v-if="activeTooltip === row.id"
                        :class="['tooltip', getTooltipPosition(rowIndex)]"
                      >
                        <div class="tooltip-content tooltip-suggestion-content">
                          <div v-for="(suggestion, idx) in getRowSuggestions(row.id)" :key="idx" class="tooltip-item">
                            <span class="tooltip-dot dot-suggestion"></span>
                            <div class="tooltip-text">
                              <div class="tooltip-column">{{ suggestion.data?.column || 'Edit' }}</div>
                              <div class="tooltip-message">{{ suggestion.title }}</div>
                              <!-- Detector context (UI-only, NOT written to the
                                   KRT cell on accept). Shows why the AI made
                                   this suggestion. -->
                              <div v-if="suggestion.context" class="tooltip-context">
                                <span class="tooltip-context-label">Why:</span>
                                {{ suggestion.context }}
                              </div>
                              <div class="tooltip-suggestion-hint">Click cell to accept/reject</div>
                            </div>
                          </div>
                        </div>
                        <div class="tooltip-arrow tooltip-arrow-suggestion"></div>
                      </div>
                    </div>
                    <!-- Error/Warning indicator for ALL issues (row-level and cell-level) -->
                    <div
                      v-if="hasAnyIssue(row.id)"
                      class="issue-indicator"
                      @mouseenter="showTooltip(row.id)"
                      @mouseleave="hideTooltip"
                    >
                      <svg
                        :class="['issue-icon', getRowIssueIconClass(row.id)]"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                      </svg>
                      <!-- Tooltip summarizing all issues -->
                      <div
                        v-if="activeTooltip === row.id"
                        :class="['tooltip', getTooltipPosition(rowIndex)]"
                      >
                        <div class="tooltip-content">
                          <!-- Errors summary -->
                          <div v-if="getErrorColumnsSummary(row.id).length > 0" class="tooltip-item">
                            <span class="tooltip-dot dot-error"></span>
                            <div class="tooltip-text">
                              <div class="tooltip-column">Errors in:</div>
                              <div class="tooltip-message">{{ getErrorColumnsSummary(row.id).join(', ') }}</div>
                            </div>
                          </div>
                          <!-- Warnings summary -->
                          <div v-if="getWarningColumnsSummary(row.id).length > 0" class="tooltip-item">
                            <span class="tooltip-dot dot-warning"></span>
                            <div class="tooltip-text">
                              <div class="tooltip-column">Warnings in:</div>
                              <div class="tooltip-message">{{ getWarningColumnsSummary(row.id).join(', ') }}</div>
                            </div>
                          </div>
                          <!-- Row-level issues -->
                          <div v-for="(error, idx) in getRowLevelIssues(row.id)" :key="'row-' + idx" class="tooltip-item">
                            <span :class="['tooltip-dot', error.severity === 'error' ? 'dot-error' : 'dot-warning']"></span>
                            <div class="tooltip-text">
                              <div class="tooltip-column">Row Issue</div>
                              <div class="tooltip-message">{{ error.message }}</div>
                            </div>
                          </div>
                          <!-- Hint -->
                          <div class="tooltip-hint">Hover over cells for details</div>
                        </div>
                        <div class="tooltip-arrow"></div>
                      </div>
                    </div>
                  </div>
                </td>

                <!-- Data Cells -->
                <td
                  v-for="col in columns"
                  :key="col.key"
                  :data-column-key="col.key"
                  :class="['col-data', getCellClass(row.id, col.key), { 'has-cell-tooltip': hasCellIssue(row.id, col.key) || hasCellSuggestion(row.id, col.key) }]"
                  @click="startEdit(row, col, rowIndex)"
                  @mouseenter="handleCellMouseEnter(row.id, col.key)"
                  @mouseleave="handleCellMouseLeave"
                >
                  <div :class="['cell-display', { editable: !readonly, 'has-quick-action': col.key === 'IDENTIFIER' && !row[col.key] && !readonly }]" :title="row[col.key] || ''">
                    <span class="cell-text-content">
                      {{ row[col.key] }}
                    </span>
                    <!-- Quick identifier shortcut buttons for empty IDENTIFIER cells -->
                    <div v-if="col.key === 'IDENTIFIER' && !row[col.key] && !readonly" class="identifier-quick-actions">
                      <button
                        class="btn-quick-id"
                        title="Set as 'No identifier exists'"
                        @click.stop="setQuickNoIdentifier(row.id, col.field)"
                      >
                        None
                      </button>
                      <button
                        class="btn-quick-id"
                        title="Set as 'Identifier pending'"
                        @click.stop="setQuickIdentifierPending(row.id, col.field)"
                      >
                        Pending
                      </button>
                    </div>
                    <!-- Cell indicators container - shows all applicable icons -->
                    <div v-if="hasCellIssue(row.id, col.key) || hasCellSuggestion(row.id, col.key)" class="cell-issue-indicators">
                      <!-- AI suggestion indicator -->
                      <svg
                        v-if="hasCellSuggestion(row.id, col.key)"
                        class="cell-issue-icon icon-suggestion"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        title="AI Suggestion"
                      >
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
                      </svg>
                      <!-- Error indicator -->
                      <svg
                        v-if="getCellErrors(row.id, col.key).some(e => e.severity === 'error')"
                        class="cell-issue-icon icon-error"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        title="Error"
                      >
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                      </svg>
                      <!-- Warning indicator -->
                      <svg
                        v-if="getCellErrors(row.id, col.key).some(e => e.severity === 'warning') && !getCellErrors(row.id, col.key).some(e => e.severity === 'error')"
                        class="cell-issue-icon icon-warning"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        title="Warning"
                      >
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                      </svg>
                    </div>
                  </div>
                  <!-- Cell tooltip for validation errors (shown on cell hover).
                       Flip to below the cell on the top few rows so it isn't
                       clipped by the table header / surrounding container. -->
                  <div
                    v-if="hasCellIssue(row.id, col.key) && isCellTooltipActive(row.id, col.key)"
                    class="cell-tooltip"
                    :class="getTooltipPosition(rowIndex) === 'below' ? 'cell-tooltip-below' : 'cell-tooltip-above'"
                  >
                    <div class="tooltip-content">
                      <div v-for="(error, idx) in getCellErrors(row.id, col.key)" :key="idx" class="tooltip-item">
                        <span :class="['tooltip-dot', error.severity === 'error' ? 'dot-error' : 'dot-warning']"></span>
                        <div class="tooltip-text">
                          <div class="tooltip-message">{{ error.message }}</div>
                          <div v-if="error.suggestion" class="tooltip-suggestion">{{ error.suggestion }}</div>
                        </div>
                      </div>
                    </div>
                    <div class="tooltip-arrow"></div>
                  </div>
                  <!-- Cell tooltip for AI suggestions (shown on cell hover) -->
                  <div
                    v-if="hasCellSuggestion(row.id, col.key) && isSuggestionTooltipActive(row.id, col.key)"
                    class="cell-tooltip cell-tooltip-suggestion"
                    :class="getTooltipPosition(rowIndex) === 'below' ? 'cell-tooltip-below' : 'cell-tooltip-above'"
                  >
                    <div class="tooltip-content tooltip-suggestion-content">
                      <div class="tooltip-item">
                        <span class="tooltip-dot dot-suggestion"></span>
                        <div class="tooltip-text">
                          <div class="tooltip-column">AI Suggestion</div>
                          <div class="tooltip-message">{{ getCellSuggestion(row.id, col.key)?.title }}</div>
                          <div class="tooltip-suggestion-value">
                            <span class="old-value">{{ getCellSuggestion(row.id, col.key)?.data?.oldValue || '(empty)' }}</span>
                            <span class="arrow">→</span>
                            <span class="new-value">{{ getCellSuggestion(row.id, col.key)?.data?.newValue }}</span>
                          </div>
                          <!-- Detector context (UI-only, NOT persisted) -->
                          <div v-if="getCellSuggestion(row.id, col.key)?.context" class="tooltip-context">
                            <span class="tooltip-context-label">Why:</span>
                            {{ getCellSuggestion(row.id, col.key).context }}
                          </div>
                          <div class="tooltip-suggestion-hint">Click cell to accept/reject</div>
                        </div>
                      </div>
                    </div>
                    <div class="tooltip-arrow tooltip-arrow-suggestion"></div>
                  </div>
                </td>

                <!-- Actions -->
                <td v-if="!readonly" class="col-actions">
                  <!-- Delete suggestion highlighted -->
                  <div v-if="hasDeleteSuggestion(row.id)" class="delete-suggestion-actions">
                    <button
                      class="btn-delete-suggestion"
                      title="AI suggests deleting this row - Click to accept"
                      @click="acceptDeleteSuggestion(getDeleteSuggestion(row.id))"
                    >
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                    <button
                      class="btn-reject-delete"
                      title="Reject delete suggestion"
                      @click="rejectDeleteSuggestion(getDeleteSuggestion(row.id))"
                    >
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <!-- Normal delete button -->
                  <button v-else class="btn-delete" title="Delete row" @click="handleDeleteRow(row.id)">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </td>
              </tr>
              <!-- Interleaved add-row suggestions after this row -->
              <tr
                v-for="suggestion in (interleavedAddSuggestions[rowIndex] || [])"
                :key="'add-' + suggestion.id"
                class="add-row-suggestion"
                :class="{ 'add-row-suggestion-active': suggestion.id === activeSuggestionId }"
                :data-suggestion-id="suggestion.id"
                @click="emit('select-suggestion', suggestion.id)"
              >
                <td v-if="!readonly" class="col-bulk-check" @click.stop>
                  <input
                    type="checkbox"
                    class="bulk-check"
                    :disabled="suggestion.status !== 'pending'"
                    :checked="isSuggestionSelected(suggestion.id)"
                    @click.stop="toggleSuggestionSelection(suggestion.id)"
                  />
                </td>
                <td :class="['col-row-num', 'add-row-num', { 'tooltip-active': activeTooltip === suggestion.id }]">
                  <div class="row-num-content">
                    <svg class="add-icon-svg" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clip-rule="evenodd" />
                    </svg>
                    <!-- Module badge(s) live in the # cell so origin column lines
                         up across ADD and UPDATE suggestions. Order mirrors the
                         edit-row pattern: <number/+> <badge> <info>. -->
                    <span
                      v-for="src in getContributingSources(suggestion)"
                      :key="src"
                      class="suggestion-source-badge"
                      :class="'source-' + src"
                    >{{ SOURCE_LABEL[src] || src }}</span>
                    <!-- Same info indicator + tooltip the edit suggestions show
                         on existing rows, mirrored here so every suggestion has
                         the same hover-for-details affordance. -->
                    <div
                      class="issue-indicator"
                      @mouseenter.stop="showTooltip(suggestion.id)"
                      @mouseleave="hideTooltip"
                    >
                      <svg class="issue-icon icon-suggestion" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
                      </svg>
                      <div
                        v-if="activeTooltip === suggestion.id"
                        :class="['tooltip', getTooltipPosition(rowIndex)]"
                      >
                        <div class="tooltip-content tooltip-suggestion-content">
                          <div class="tooltip-item">
                            <span class="tooltip-dot dot-suggestion"></span>
                            <div class="tooltip-text">
                              <div class="tooltip-column">Add {{ suggestion.data?.resourceType || 'row' }}</div>
                              <div class="tooltip-message">{{ suggestion.title }}</div>
                              <div v-if="suggestion.detail" class="tooltip-message">{{ suggestion.detail }}</div>
                              <div class="tooltip-suggestion-hint">Accept (✓) or reject (✗) on the right</div>
                            </div>
                          </div>
                        </div>
                        <div class="tooltip-arrow tooltip-arrow-suggestion"></div>
                      </div>
                    </div>
                  </div>
                </td>
                <!-- RESOURCE TYPE: editable dropdown for pending suggestions. -->
                <td class="col-data add-row-cell" @click.stop>
                  <div class="add-row-type-cell">
                    <select
                      v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                      v-model="editorSuggestionEdits[suggestion.id].resourceType"
                      class="suggestion-inline-input"
                      title="Resource Type"
                    >
                      <option v-for="name in resourceTypesStore.resourceTypeNames" :key="name" :value="name">{{ name }}</option>
                    </select>
                    <span v-else class="cell-display">{{ suggestion.data?.resourceType || '' }}</span>
                    <span v-if="suggestion.existsInKRT === 'exact'" class="suggestion-source-badge source-in-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Already in KRT: ${suggestion.matchedKRTRow.resourceName}` : ''">In KRT</span>
                    <span v-else-if="suggestion.existsInKRT === 'update'" class="suggestion-source-badge source-update-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Update existing: ${suggestion.matchedKRTRow.resourceName}` : ''">Update</span>
                  </div>
                </td>
                <!-- RESOURCE NAME -->
                <td class="col-data add-row-cell" @click.stop>
                  <input
                    v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                    v-model="editorSuggestionEdits[suggestion.id].resourceName"
                    type="text"
                    class="suggestion-inline-input"
                    title="Resource Name"
                  />
                  <div v-else class="cell-display" :title="suggestion.data?.resourceName || ''">{{ suggestion.data?.resourceName || '' }}</div>
                </td>
                <!-- SOURCE -->
                <td class="col-data add-row-cell" @click.stop>
                  <input
                    v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                    v-model="editorSuggestionEdits[suggestion.id].source"
                    type="text"
                    class="suggestion-inline-input"
                    title="Source"
                  />
                  <div v-else class="cell-display" :title="suggestion.data?.source || ''">{{ suggestion.data?.source || '' }}</div>
                </td>
                <!-- IDENTIFIER -->
                <td class="col-data add-row-cell" @click.stop>
                  <input
                    v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                    v-model="editorSuggestionEdits[suggestion.id].identifier"
                    type="text"
                    class="suggestion-inline-input"
                    title="Identifier"
                  />
                  <div v-else class="cell-display" :title="suggestion.data?.identifier || ''">{{ suggestion.data?.identifier || '' }}</div>
                </td>
                <!-- NEW/REUSE -->
                <td class="col-data add-row-cell" @click.stop>
                  <select
                    v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                    v-model="editorSuggestionEdits[suggestion.id].newReuse"
                    class="suggestion-inline-input"
                    title="New/Reuse"
                  >
                    <option value="">—</option>
                    <option value="new">new</option>
                    <option value="reuse">reuse</option>
                  </select>
                  <span v-else>{{ suggestion.data?.newReuse || '' }}</span>
                </td>
                <!-- ADDITIONAL INFORMATION -->
                <td class="col-data add-row-cell" @click.stop>
                  <input
                    v-if="suggestion.status === 'pending' && editorSuggestionEdits[suggestion.id]"
                    v-model="editorSuggestionEdits[suggestion.id].additionalInformation"
                    type="text"
                    class="suggestion-inline-input"
                    title="Additional Information"
                  />
                  <div v-else class="cell-display" :title="suggestion.data?.additionalInformation || ''">{{ suggestion.data?.additionalInformation || '' }}</div>
                </td>
                <td v-if="!readonly" class="col-actions add-row-actions">
                  <div class="add-row-buttons">
                    <button v-if="suggestion.existsInKRT !== 'exact'" class="btn-accept-add" :title="suggestion.existsInKRT === 'update' ? 'Accept - Update existing row' : 'Accept - Add this row'" @click.stop="acceptAddRowSuggestion(suggestion)">
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button class="btn-reject-add" title="Reject suggestion" @click.stop="rejectAddRowSuggestion(suggestion)">
                      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Edit Cell Modal -->
    <KRTCellEditModal
      v-model="modalValue"
      :show="showEditModal"
      :cell="modalCell"
      :issues="getModalCellIssues()"
      :suggestion="getModalCellSuggestion()"
      :resource-types="resourceTypes"
      @close="closeEditModal"
      @save="saveModalEdit"
      @accept-suggestion="acceptSuggestion"
      @reject-suggestion="(suggestion, reason) => rejectSuggestion(suggestion, reason)"
    />

    <!-- Reject Suggestion Modal -->
    <Teleport to="body">
      <div v-if="showRejectModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="cancelRejectModal">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <h3 class="text-sm font-semibold text-gray-900 mb-2">Reject Suggestion</h3>
          <p class="text-sm text-gray-500 mb-3">Why are you rejecting this suggestion? (optional)</p>
          <textarea
            v-model="rejectReasonText"
            class="w-full border border-gray-300 rounded-md p-2 text-sm resize-none focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            rows="3"
            placeholder="Enter reason..."
            @keydown.enter.ctrl="confirmRejectModal"
          ></textarea>
          <div class="flex justify-end gap-2 mt-3">
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200" @click="cancelRejectModal">
              Cancel
            </button>
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-red-600 text-white hover:bg-red-700" @click="confirmRejectModal">
              Reject
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Bulk: Approve with Resource Type modal -->
    <Teleport to="body">
      <div v-if="showBulkResourceTypeModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showBulkResourceTypeModal = false">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <h3 class="text-sm font-semibold text-gray-900 mb-2">Approve {{ selectedSuggestionIds.size }} suggestion{{ selectedSuggestionIds.size > 1 ? 's' : '' }}</h3>
          <p class="text-sm text-gray-500 mb-3">
            Pick a Resource Type to apply to every selected add suggestion before approving.
            The detector's suggested type will be overridden with your choice.
          </p>
          <select
            v-model="bulkResourceTypeValue"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          >
            <option value="">Select Resource Type…</option>
            <option v-for="type in resourceTypes" :key="type" :value="type">{{ type }}</option>
          </select>
          <div class="flex justify-end gap-2 mt-4">
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200" @click="showBulkResourceTypeModal = false">Cancel</button>
            <button :disabled="!bulkResourceTypeValue || bulkSubmitting" class="px-3 py-1.5 text-sm font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50" @click="confirmBulkResourceType">
              {{ bulkSubmitting ? 'Approving…' : 'Approve with type' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Bulk: Edit column on selected KRT rows -->
    <Teleport to="body">
      <div v-if="showBulkEditCellsModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showBulkEditCellsModal = false">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <h3 class="text-sm font-semibold text-gray-900 mb-2">Edit column on {{ selectedRowIds.size }} row{{ selectedRowIds.size > 1 ? 's' : '' }}</h3>
          <p class="text-sm text-gray-500 mb-3">Choose a column and the value to apply to every selected row.</p>
          <label class="text-xs font-medium text-gray-600">Column</label>
          <select
            v-model="bulkEditCellsColumn"
            class="w-full px-3 py-2 mt-1 mb-3 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          >
            <option v-for="col in columns" :key="col.key" :value="col.key">{{ col.label }}</option>
          </select>
          <label class="text-xs font-medium text-gray-600">Value</label>
          <select
            v-if="bulkEditCellsColumn === 'RESOURCE TYPE'"
            v-model="bulkEditCellsValue"
            class="w-full px-3 py-2 mt-1 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          >
            <option value="">Select Resource Type…</option>
            <option v-for="type in resourceTypes" :key="type" :value="type">{{ type }}</option>
          </select>
          <select
            v-else-if="bulkEditCellsColumn === 'NEW/REUSE'"
            v-model="bulkEditCellsValue"
            class="w-full px-3 py-2 mt-1 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          >
            <option value="">Select…</option>
            <option value="new">new</option>
            <option value="reuse">reuse</option>
          </select>
          <input
            v-else
            v-model="bulkEditCellsValue"
            type="text"
            class="w-full px-3 py-2 mt-1 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
            placeholder="Enter new value"
          />
          <div class="flex justify-end gap-2 mt-4">
            <button class="px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200" @click="showBulkEditCellsModal = false">Cancel</button>
            <button :disabled="!bulkEditCellsValue || bulkSubmitting" class="px-3 py-1.5 text-sm font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50" @click="applyBulkEditCells">
              {{ bulkSubmitting ? 'Applying…' : 'Apply to selected' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Loading Overlay -->
    <div v-if="loading" class="loading-overlay">
      <div class="loading-spinner">
        <svg class="spinner" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Processing...</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.krt-editor {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  min-width: 0; /* Allow shrinking below content size in flex layouts */
  overflow: hidden; /* Prevent content from expanding the container */
}

/* Summary Bar */
.summary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: #f9fafb;
  border-radius: 0.375rem;
}

.stats {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.stat {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
}

.stat-value {
  font-size: 1rem;
  font-weight: 600;
  color: #111827;
}

.stat-error {
  color: #dc2626;
}

.stat-warning {
  color: #d97706;
}

.stat-label {
  color: #6b7280;
  font-size: 0.75rem;
}

.stat-clickable {
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  margin: -0.25rem -0.5rem;
  border-radius: 0.375rem;
  transition: background 0.15s;
}

.stat-clickable:hover {
  background: #dbeafe;
}

/* Resource Type Tabs */
.tabs-container {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  gap: 1rem;
}

.tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 0;
  flex: 1;
  min-width: 0;
}

/* Search bar */
.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-bottom: 1px;
}

.search-icon {
  position: absolute;
  left: 0.5rem;
  width: 0.875rem;
  height: 0.875rem;
  color: #9ca3af;
  pointer-events: none;
}

.search-input {
  padding: 0.375rem 1.75rem 0.375rem 1.75rem;
  font-size: 0.8125rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  width: 160px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.search-input:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
}

.search-clear {
  position: absolute;
  right: 0.375rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  color: #9ca3af;
  cursor: pointer;
  border-radius: 50%;
}

.search-clear:hover {
  color: #374151;
  background: #f3f4f6;
}

.search-clear svg {
  width: 0.75rem;
  height: 0.75rem;
}

/* Tab label badge in summary bar */
.tab-label-badge {
  font-size: 0.75rem;
  font-weight: 500;
  color: #374151;
  margin-left: 0.25rem;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #6b7280;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  margin-bottom: -1px;
}

.tab:hover {
  color: #374151;
  background: #f3f4f6;
}

.tab-active {
  color: #2563eb;
  border-bottom-color: #2563eb;
}

.tab-active:hover {
  background: transparent;
}

.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  background: #e5e7eb;
  color: #374151;
  border-radius: 9999px;
}

.tab-active .tab-count {
  background: #dbeafe;
  color: #2563eb;
}

/* Empty state for filtered view */
.empty-filtered {
  padding: 2rem;
  text-align: center;
  color: #6b7280;
  font-size: 0.875rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}

/* Add Row Form */
.add-row-form {
  padding: 1rem;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 0.5rem;
}

.form-title {
  font-weight: 500;
  color: #1e40af;
  margin-bottom: 0.75rem;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}

.form-field label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: #374151;
  margin-bottom: 0.25rem;
}

.form-field input,
.form-field select {
  width: 100%;
  padding: 0.5rem;
  font-size: 0.875rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
}

.form-actions {
  margin-top: 0.75rem;
  display: flex;
  justify-content: flex-end;
}

/* Table Container - This is the key fix */
.table-container {
  width: 100%;
  min-width: 0; /* Allow shrinking in flex layouts */
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  background: #fff;
  overflow: hidden;
}

.table-scroll {
  width: 100%;
  max-height: calc(100vh - 400px);
  min-height: 200px;
  overflow: auto;
}

/* Table */
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

thead {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #f9fafb;
}

th {
  padding: 0.75rem;
  text-align: left;
  font-size: 0.75rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  border-bottom: 1px solid #e5e7eb;
  white-space: nowrap;
}

td {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
}

/* Column Widths */
.col-row-num {
  /* Slightly wider than before to fit the per-row module badge ("SW", "PROT",
     "ID", …) introduced alongside update suggestions. Tighter horizontal
     padding than the default td so the row number, badge, and info icon all
     land on the same line. */
  width: 88px;
  min-width: 88px;
  padding-left: 0.375rem;
  padding-right: 0.375rem;
  position: sticky;
  left: 0;
  z-index: 5;
  background: #fff;
  border-right: 1px solid #e5e7eb;
}

thead .col-row-num {
  z-index: 15;
  background: #f9fafb;
}

tbody tr:hover .col-row-num {
  background: #f9fafb;
}

/* Elevate z-index when tooltip is active to prevent clipping */
.col-row-num.tooltip-active {
  z-index: 100;
}

.col-data {
  /* No min-width - allow free resizing */
}

.col-actions {
  width: 60px;
  min-width: 60px;
  text-align: center;
  position: sticky;
  right: 0;
  z-index: 5;
  background: #fff;
  border-left: 1px solid #e5e7eb;
}

thead .col-actions {
  z-index: 15;
  background: #f9fafb;
}

tbody tr:hover .col-actions {
  background: #f9fafb;
}

/* Row States */
tr:hover {
  background: #f9fafb;
}

/* Row-level issues: only highlight the row number cell */
.row-error > .col-row-num {
  background: #fef2f2 !important;
  border-left: 3px solid #ef4444;
}

.row-warning > .col-row-num {
  background: #fffbeb !important;
  border-left: 3px solid #f59e0b;
}

.row-suggestion > .col-row-num {
  background: #eff6ff !important;
  border-left: 3px solid #3b82f6;
}

/* Cell-level issues: highlight specific cells */
.cell-error {
  background: #fee2e2 !important;
  box-shadow: inset 0 0 0 1px #ef4444;
}

.cell-warning {
  background: #fef3c7 !important;
  box-shadow: inset 0 0 0 1px #f59e0b;
}

/* Row Number Content */
.row-num-content {
  display: flex;
  align-items: center;
  /* Tight gap so the row number, badge, and info icon fit on one line in
     the sticky # column without wrapping. */
  gap: 0.1875rem;
  flex-wrap: wrap;
}

/* Row number stays on the first line, narrow enough to leave room for a
   short module-source badge next to it (e.g. "12 PROT"). */
.row-num-label {
  font-variant-numeric: tabular-nums;
}

/* Issue Indicator */
.issue-indicator {
  position: relative;
  cursor: help;
}

.issue-icon {
  width: 1rem;
  height: 1rem;
}

.icon-error {
  color: #ef4444;
}

.icon-warning {
  color: #f59e0b;
}

/* Cell with tooltip needs relative positioning */
.col-data.has-cell-tooltip {
  position: relative;
}

/* Cell-level issue indicators (multiple icons container) */
.cell-issue-indicators {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  margin-left: 0.25rem;
  flex-shrink: 0;
}

.cell-issue-indicator {
  display: inline-flex;
  align-items: center;
  margin-left: 0.25rem;
  flex-shrink: 0;
}

.cell-issue-icon {
  width: 0.875rem;
  height: 0.875rem;
}

/* Cell tooltip - positioned relative to the td cell */
.cell-tooltip {
  position: absolute;
  left: 0;
  z-index: 60;
  width: 280px;
}

/* Default placement above the cell — used for rows beyond the first few. */
.cell-tooltip-above {
  bottom: 100%;
  margin-bottom: 0.25rem;
}

/* Top-of-table rows render the tooltip BELOW the cell so it isn't clipped
   by the table header / surrounding scroll container. */
.cell-tooltip-below {
  top: 100%;
  margin-top: 0.25rem;
}

.cell-tooltip .tooltip-content {
  background: #1f2937;
  color: #fff;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
}

/* Arrow under the tooltip when it sits above the cell. */
.cell-tooltip-above .tooltip-arrow {
  position: absolute;
  left: 1rem;
  top: 100%;
  border: 6px solid transparent;
  border-top-color: #1f2937;
}

/* Arrow above the tooltip when it sits below the cell — flip the colored edge. */
.cell-tooltip-below .tooltip-arrow {
  position: absolute;
  left: 1rem;
  bottom: 100%;
  border: 6px solid transparent;
  border-bottom-color: #1f2937;
}

/* Tooltip */
.tooltip {
  position: absolute;
  left: 0;
  z-index: 50;
  width: 280px;
}

.tooltip.below {
  top: 100%;
  margin-top: 0.5rem;
}

.tooltip.above {
  bottom: 100%;
  margin-bottom: 0.5rem;
}

.tooltip-content {
  background: #1f2937;
  color: #fff;
  font-size: 0.75rem;
  border-radius: 0.5rem;
  padding: 0.75rem;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}

.tooltip-item {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.tooltip-item:last-child {
  margin-bottom: 0;
}

.tooltip-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  margin-top: 0.25rem;
  flex-shrink: 0;
}

.dot-error {
  background: #f87171;
}

.dot-warning {
  background: #fbbf24;
}

.tooltip-column {
  font-weight: 600;
}

.tooltip-message {
  color: #d1d5db;
}

.tooltip-suggestion {
  color: #93c5fd;
  margin-top: 0.25rem;
}

.tooltip-hint {
  color: #9ca3af;
  font-size: 0.65rem;
  font-style: italic;
  margin-top: 0.5rem;
  padding-top: 0.375rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.tooltip-arrow {
  position: absolute;
  left: 0.75rem;
  width: 0;
  height: 0;
  border-left: 0.5rem solid transparent;
  border-right: 0.5rem solid transparent;
}

.tooltip.below .tooltip-arrow {
  top: -0.375rem;
  border-bottom: 0.5rem solid #1f2937;
}

.tooltip.above .tooltip-arrow {
  bottom: -0.375rem;
  border-top: 0.5rem solid #1f2937;
}

/* Cell Display */
.cell-display {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 300px;
  padding: 0.25rem;
  border-radius: 0.25rem;
}

.cell-display .cell-text-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-display.editable {
  cursor: pointer;
}

.cell-display.editable:hover {
  background: #f3f4f6;
}

.cell-display.has-quick-action {
  justify-content: space-between;
}

/* Quick identifier shortcut buttons */
.identifier-quick-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
}

.btn-quick-id {
  padding: 0.125rem 0.375rem;
  font-size: 0.6rem;
  font-weight: 600;
  color: #6b7280;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 0.25rem;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-quick-id:hover {
  background: #e5e7eb;
  color: #374151;
  border-color: #9ca3af;
}


/* Delete Button */
.btn-delete {
  padding: 0.25rem;
  color: #dc2626;
  border-radius: 0.25rem;
}

.btn-delete:hover {
  background: #fee2e2;
}

.btn-delete svg {
  width: 1rem;
  height: 1rem;
}

/* Loading Overlay */
.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.loading-spinner {
  background: #fff;
  padding: 1rem 1.5rem;
  border-radius: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}

.spinner {
  width: 1.25rem;
  height: 1.25rem;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* AI Suggestions Styling */
.stat-suggestion {
  color: #2563eb;
}

.icon-suggestion {
  color: #2563eb;
}

.cell-suggestion {
  background: #dbeafe !important;
  box-shadow: inset 0 0 0 1px #3b82f6;
}

.cell-suggestion-icon {
  color: #2563eb;
  margin-left: 0.25rem;
  vertical-align: middle;
}

/* Suggestion tooltip for row indicator */
.dot-suggestion {
  background: #3b82f6;
}

.tooltip-suggestion-item {
  color: #93c5fd;
}

.tooltip-suggestion-content {
  background: #1e3a8a;
}

.tooltip-suggestion-hint {
  color: #93c5fd;
  font-size: 0.65rem;
  margin-top: 0.25rem;
  font-style: italic;
}

/* Detector context — the original ADDITIONAL INFORMATION blurb the AI
   produced, surfaced as hover hint only. Never written to the KRT cell. */
.tooltip-context {
  color: #cbd5e1;
  font-size: 0.7rem;
  margin-top: 0.375rem;
  padding-top: 0.375rem;
  border-top: 1px dashed rgba(255, 255, 255, 0.15);
  line-height: 1.35;
}

.tooltip-context-label {
  color: #f0abfc;
  font-weight: 600;
  margin-right: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-size: 0.6rem;
}

.tooltip-arrow-suggestion {
  border-bottom-color: #1e3a8a !important;
  border-top-color: #1e3a8a !important;
}

/* Cell tooltip for AI suggestions */
.cell-tooltip-suggestion .tooltip-content {
  background: #1e3a8a;
}

/* Suggestion-variant arrows — only override the visible edge depending on
   whether the tooltip is above or below the cell. */
.cell-tooltip-suggestion.cell-tooltip-above .tooltip-arrow {
  border-top-color: #1e3a8a;
}
.cell-tooltip-suggestion.cell-tooltip-below .tooltip-arrow {
  border-bottom-color: #1e3a8a;
}

.tooltip-suggestion-value {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.375rem;
  padding: 0.375rem;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 0.25rem;
  font-size: 0.7rem;
}

.tooltip-suggestion-value .old-value {
  color: #fca5a5;
  text-decoration: line-through;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tooltip-suggestion-value .arrow {
  color: #93c5fd;
  flex-shrink: 0;
}

.tooltip-suggestion-value .new-value {
  color: #86efac;
  font-weight: 500;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Add Row Suggestion Styles
 *
 * The blue highlight covers the row-num column + every data cell, but NOT
 * the bulk-check column at the leading edge. That matches the pattern used
 * for `.row-suggestion / .row-warning / .row-error` (which also leaves
 * `.col-bulk-check` neutral) so all highlight types behave consistently. */
.add-row-suggestion {
  cursor: pointer;
}

.add-row-suggestion > td:not(.col-bulk-check) {
  background: #eff6ff;
}

.add-row-suggestion > .col-row-num.add-row-num {
  border-left: 3px solid #3b82f6;
}

.add-row-suggestion:hover > td:not(.col-bulk-check) {
  background: #dbeafe;
}

/* Currently-displayed suggestion in the parent's AI suggestions panel —
   darker bg + thicker accent so it's obvious which row the detail view shows.
   Uses the same blue family as the base row, just stepped up. */
.add-row-suggestion-active > td:not(.col-bulk-check),
.add-row-suggestion-active:hover > td:not(.col-bulk-check) {
  background: #bfdbfe;
}
.add-row-suggestion-active > .col-row-num.add-row-num {
  border-left-color: #1d4ed8;
}
.add-row-suggestion-active .add-row-num {
  background: #93c5fd !important;
  border-right-color: #1d4ed8;
}

.add-row-num {
  background: #dbeafe !important;
  border-right: 1px solid #93c5fd;
}

.add-row-cell {
  background: transparent;
  color: #1e40af;
  font-style: italic;
}

.add-row-cell .cell-display {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-row-type-cell {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.suggestion-source-badge {
  display: inline-block;
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.5625rem;
  font-weight: 600;
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.source-software_detection {
  background: #f3e8ff;
  color: #7c3aed;
}

.source-pdf_analysis {
  background: #e0e7ff;
  color: #4338ca;
}

.source-datasets_detection {
  background: #dbeafe;
  color: #1d4ed8;
}

.source-materials_detection {
  background: #fef3c7;
  color: #92400e;
}

.source-protocols_detection {
  background: #d1fae5;
  color: #047857;
}

.source-identifier_detection {
  background: #ccfbf1;
  color: #0f766e;
}

.source-in-krt {
  background: #e5e7eb;
  color: #374151;
}

.source-update-krt {
  background: #e0e7ff;
  color: #3730a3;
}

.add-icon {
  font-weight: 700;
  font-size: 1rem;
  color: #2563eb;
}

.add-icon-svg {
  /* Sized to match `.issue-icon` so the + and ? icons line up visually
     when both share the # cell. */
  width: 1rem;
  height: 1rem;
  color: #2563eb;
}

.add-row-actions {
  background: #dbeafe !important;
}

.add-row-buttons {
  display: flex;
  gap: 0.25rem;
}

.btn-accept-add {
  padding: 0.25rem;
  color: #10b981;
  border-radius: 0.25rem;
  transition: background 0.15s;
}

.btn-accept-add:hover {
  background: #d1fae5;
}

.btn-accept-add svg {
  width: 1rem;
  height: 1rem;
}

.btn-reject-add {
  padding: 0.25rem;
  color: #6b7280;
  border-radius: 0.25rem;
  transition: background 0.15s;
}

.btn-reject-add:hover {
  background: #f3f4f6;
  color: #ef4444;
}

.btn-reject-add svg {
  width: 1rem;
  height: 1rem;
}

/* Delete Suggestion Styles */
.delete-suggestion-actions {
  display: flex;
  gap: 0.25rem;
}

.btn-delete-suggestion {
  padding: 0.25rem;
  color: #fff;
  background: #f59e0b;
  border-radius: 0.25rem;
  animation: pulse-delete 2s infinite;
}

.btn-delete-suggestion:hover {
  background: #d97706;
}

.btn-delete-suggestion svg {
  width: 1rem;
  height: 1rem;
}

.btn-reject-delete {
  padding: 0.25rem;
  color: #6b7280;
  border-radius: 0.25rem;
}

.btn-reject-delete:hover {
  background: #f3f4f6;
}

.btn-reject-delete svg {
  width: 0.875rem;
  height: 0.875rem;
}

@keyframes pulse-delete {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0);
  }
}

/* Row with delete suggestion */
tr:has(.btn-delete-suggestion) {
  background: #fef3c7 !important;
}

tr:has(.btn-delete-suggestion) .col-row-num {
  background: #fef3c7 !important;
  border-left: 3px solid #f59e0b;
}

tr:has(.btn-delete-suggestion) .col-actions {
  background: #fef3c7 !important;
}

/* Highlight flash animation for scroll-to-row */
@keyframes highlight-flash {
  0%, 100% {
    background-color: inherit;
  }
  25%, 75% {
    background-color: #fef08a;
  }
}

tr.highlight-flash {
  animation: highlight-flash 2s ease-in-out;
}

tr.highlight-flash td {
  animation: highlight-flash 2s ease-in-out;
}

/* Column sorting styles */
.col-sortable {
  cursor: pointer;
  user-select: none;
}

.col-sortable:hover {
  background: #f3f4f6;
}

.th-content {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.sort-icon {
  width: 0.75rem;
  height: 0.75rem;
  flex-shrink: 0;
  color: #374151;
}

.sort-icon-idle {
  opacity: 0;
  transition: opacity 0.15s;
}

.col-sortable:hover .sort-icon-idle {
  opacity: 0.4;
}

/* Download Dropdown */
.download-dropdown-wrapper {
  position: relative;
}

.download-dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 0.375rem;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  z-index: 50;
  min-width: 160px;
  overflow: hidden;
}

.download-dropdown-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: #374151;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}

.download-dropdown-item:hover {
  background: #f3f4f6;
  color: #111827;
}

.download-dropdown-item + .download-dropdown-item {
  border-top: 1px solid #f3f4f6;
}

/* ── Bulk-ops UI ───────────────────────────────────────────────── */
.bulk-action-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  position: sticky;
  top: 0.5rem;
  z-index: 10;
}
.bulk-action-count {
  font-weight: 600;
  color: #1e40af;
}
.bulk-action-buttons {
  margin-left: auto;
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.btn-bulk {
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 500;
  background: #fff;
  color: #374151;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-bulk:hover:not(:disabled) { background: #f3f4f6; }
.btn-bulk:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-bulk-primary {
  background: #2563eb;
  color: #fff;
  border-color: #2563eb;
}
.btn-bulk-primary:hover:not(:disabled) { background: #1d4ed8; }
.btn-bulk-danger {
  background: #ef4444;
  color: #fff;
  border-color: #ef4444;
}
.btn-bulk-danger:hover:not(:disabled) { background: #dc2626; }
.btn-bulk-ghost {
  border-color: transparent;
  color: #6b7280;
}
.btn-bulk-ghost:hover:not(:disabled) { background: transparent; color: #374151; }

/* Checkbox column — narrow leading column for bulk selection */
.col-bulk-check {
  width: 2.25rem;
  text-align: center;
  vertical-align: middle;
}
.bulk-check {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: #2563eb;
}
.bulk-check:disabled { cursor: not-allowed; opacity: 0.4; }

/* Inline inputs on suggestion rows — flat, table-cell-style. Border only
   appears on hover/focus so the row reads like a row, not a form. */
.suggestion-inline-input {
  width: 100%;
  min-width: 0;
  padding: 0.125rem 0.25rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.25rem;
  font-size: inherit;
  font-family: inherit;
  color: #111827;
  transition: border-color 0.15s, background 0.15s;
}
.suggestion-inline-input:hover {
  border-color: #cbd5e1;
  background: #ffffff;
}
.suggestion-inline-input:focus {
  outline: none;
  border-color: #3b82f6;
  background: #ffffff;
  box-shadow: 0 0 0 1px #3b82f6;
}
/* Native <select> appearance is OS-dependent; force a consistent compact look. */
select.suggestion-inline-input {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 1.25rem;
  background-image: linear-gradient(45deg, transparent 50%, #6b7280 50%),
                    linear-gradient(135deg, #6b7280 50%, transparent 50%);
  background-position: calc(100% - 0.5rem) 50%, calc(100% - 0.3rem) 50%;
  background-size: 5px 5px;
  background-repeat: no-repeat;
}

</style>
