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
  { key: 'Code/Software', label: 'Code/Software' },
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

// Default sort: by resource type group, then by resource name A-Z
function defaultSort(a, b) {
  const groupA = resourceTypesStore.getGroupSortOrder(a['RESOURCE TYPE'])
  const groupB = resourceTypesStore.getGroupSortOrder(b['RESOURCE TYPE'])
  if (groupA !== groupB) return groupA - groupB
  return (a['RESOURCE NAME'] || '').localeCompare(b['RESOURCE NAME'] || '')
}

// Filtered rows based on active tab (with group + name ordering) + search
const filteredRows = computed(() => {
  let rows
  if (activeTab.value === 'all') {
    rows = [...krtRows.value].sort(defaultSort)
  } else {
    rows = krtRows.value
      .filter(row => getResourceGroup(row['RESOURCE TYPE']) === activeTab.value)
      .sort((a, b) => (a['RESOURCE NAME'] || '').localeCompare(b['RESOURCE NAME'] || ''))
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

// Accept an add_row suggestion
async function acceptAddRowSuggestion(suggestion) {
  if (!suggestion) return

  try {
    await suggestionService.approveSuggestion(props.submissionId, suggestion.id)
    krtStore.updateSuggestionStatus(suggestion.id, 'approved')
    await krtStore.fetchKRT(props.submissionId)
    // Re-validate to catch any issues with the new row (e.g., missing IDENTIFIER)
    await krtStore.validate(props.submissionId)
    notificationStore.success('Row added')
    emit('suggestion-accepted', suggestion)

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
  rejectReasonText.value = ''
}

async function confirmRejectModal() {
  if (!rejectingSuggestion.value) return
  const suggestion = rejectingSuggestion.value
  const reason = rejectReasonText.value.trim()
  showRejectModal.value = false
  rejectingSuggestion.value = null
  rejectReasonText.value = ''

  try {
    await suggestionService.rejectSuggestion(props.submissionId, suggestion.id, reason)
    krtStore.updateSuggestionStatus(suggestion.id, 'rejected')
    notificationStore.info('Suggestion rejected')
    emit('suggestion-rejected', suggestion)
  } catch (error) {
    notificationStore.error('Failed to reject suggestion')
  }
}

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

    <!-- Table Container -->
    <div v-if="sortedFilteredRows.length || filteredAddRowSuggestions.length" ref="tableContainer" class="table-container">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
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
              <td class="col-row-num add-row-num">
                <div class="row-num-content">
                  <svg class="add-icon-svg" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clip-rule="evenodd" />
                  </svg>
                </div>
              </td>
              <td class="col-data add-row-cell">
                <div class="add-row-type-cell">
                  {{ suggestion.data?.resourceType || '' }}
                  <span
                    v-for="src in getContributingSources(suggestion)"
                    :key="src"
                    class="suggestion-source-badge"
                    :class="'source-' + src"
                  >{{ SOURCE_LABEL[src] || src }}</span>
                  <span v-if="suggestion.existsInKRT === 'exact'" class="suggestion-source-badge source-in-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Already in KRT: ${suggestion.matchedKRTRow.resourceName}` : ''">In KRT</span>
                  <span v-else-if="suggestion.existsInKRT === 'update'" class="suggestion-source-badge source-update-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Update existing: ${suggestion.matchedKRTRow.resourceName}` : ''">Update</span>
                </div>
              </td>
              <td class="col-data add-row-cell">
                <div class="cell-display" :title="suggestion.data?.resourceName || ''">{{ suggestion.data?.resourceName || '' }}</div>
              </td>
              <td class="col-data add-row-cell">
                <div class="cell-display" :title="suggestion.data?.source || ''">{{ suggestion.data?.source || '' }}</div>
              </td>
              <td class="col-data add-row-cell">
                <div class="cell-display" :title="suggestion.data?.identifier || ''">{{ suggestion.data?.identifier || '' }}</div>
              </td>
              <td class="col-data add-row-cell">{{ suggestion.data?.newReuse || '' }}</td>
              <td class="col-data add-row-cell">
                <div class="cell-display" :title="suggestion.data?.additionalInformation || ''">{{ suggestion.data?.additionalInformation || '' }}</div>
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
                <!-- Row Number -->
                <td :class="['col-row-num', { 'tooltip-active': activeTooltip === row.id }]">
                  <div class="row-num-content">
                    <span>{{ rowIndex + 1 }}</span>
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
                  <!-- Cell tooltip for validation errors (shown on cell hover) -->
                  <div
                    v-if="hasCellIssue(row.id, col.key) && isCellTooltipActive(row.id, col.key)"
                    class="cell-tooltip"
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
                <td class="col-row-num add-row-num">
                  <div class="row-num-content">
                    <svg class="add-icon-svg" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clip-rule="evenodd" />
                    </svg>
                  </div>
                </td>
                <td class="col-data add-row-cell">
                  <div class="add-row-type-cell">
                    {{ suggestion.data?.resourceType || '' }}
                    <span
                      v-for="src in getContributingSources(suggestion)"
                      :key="src"
                      class="suggestion-source-badge"
                      :class="'source-' + src"
                    >{{ SOURCE_LABEL[src] || src }}</span>
                    <span v-if="suggestion.existsInKRT === 'exact'" class="suggestion-source-badge source-in-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Already in KRT: ${suggestion.matchedKRTRow.resourceName}` : ''">In KRT</span>
                    <span v-else-if="suggestion.existsInKRT === 'update'" class="suggestion-source-badge source-update-krt" :title="suggestion.matchedKRTRow?.resourceName ? `Update existing: ${suggestion.matchedKRTRow.resourceName}` : ''">Update</span>
                  </div>
                </td>
                <td class="col-data add-row-cell">
                  <div class="cell-display" :title="suggestion.data?.resourceName || ''">{{ suggestion.data?.resourceName || '' }}</div>
                </td>
                <td class="col-data add-row-cell">
                  <div class="cell-display" :title="suggestion.data?.source || ''">{{ suggestion.data?.source || '' }}</div>
                </td>
                <td class="col-data add-row-cell">
                  <div class="cell-display" :title="suggestion.data?.identifier || ''">{{ suggestion.data?.identifier || '' }}</div>
                </td>
                <td class="col-data add-row-cell">{{ suggestion.data?.newReuse || '' }}</td>
                <td class="col-data add-row-cell">
                  <div class="cell-display" :title="suggestion.data?.additionalInformation || ''">{{ suggestion.data?.additionalInformation || '' }}</div>
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
  width: 60px;
  min-width: 60px;
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
  gap: 0.25rem;
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
  bottom: 100%;
  margin-bottom: 0.25rem;
  z-index: 60;
  width: 280px;
}

.cell-tooltip .tooltip-content {
  background: #1f2937;
  color: #fff;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
}

.cell-tooltip .tooltip-arrow {
  position: absolute;
  left: 1rem;
  top: 100%;
  border: 6px solid transparent;
  border-top-color: #1f2937;
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

.tooltip-arrow-suggestion {
  border-bottom-color: #1e3a8a !important;
  border-top-color: #1e3a8a !important;
}

/* Cell tooltip for AI suggestions */
.cell-tooltip-suggestion .tooltip-content {
  background: #1e3a8a;
}

.cell-tooltip-suggestion .tooltip-arrow {
  border-top-color: #1e3a8a;
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

/* Add Row Suggestion Styles */
.add-row-suggestion {
  background: #eff6ff;
  border-left: 3px solid #3b82f6;
  cursor: pointer;
}

.add-row-suggestion:hover {
  background: #dbeafe;
}

/* Currently-displayed suggestion in the parent's AI suggestions panel —
   darker bg + thicker accent so it's obvious which row the detail view shows.
   Uses the same blue family as the base row, just stepped up. */
.add-row-suggestion-active,
.add-row-suggestion-active:hover {
  background: #bfdbfe;
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
  width: 1.25rem;
  height: 1.25rem;
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

</style>
