import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import krtService from '@/services/krt.service'
import suggestionService from '@/services/suggestion.service'

/**
 * KRT Store - Manages Key Resources Table data and AI suggestions
 *
 * @module stores/krt
 *
 * State:
 * - rows: Array of KRT row data
 * - validationErrors: Object mapping row UUIDs to validation issues
 * - aiSuggestions: Array of AI-generated change suggestions from PDF analysis
 * - loading/error: Loading and error states
 * - summary: Aggregated counts of errors, warnings, and suggestions
 *
 * Key Features:
 * - CRUD operations for KRT rows
 * - Real-time validation
 * - AI suggestion matching to rows/cells
 */
export const useKRTStore = defineStore('krt', () => {
  // State
  const rows = ref([])
  const validationErrors = ref({})
  const aiSuggestions = ref([]) // AI suggestions from PDF analysis
  const editingCell = ref(null)
  const hasUnsavedChanges = ref(false)
  const loading = ref(false)
  const validating = ref(false)
  const error = ref(null)
  const summary = ref({
    totalErrors: 0,
    totalWarnings: 0,
    totalSuggestions: 0
  })

  // Getters
  const rowCount = computed(() => rows.value.length)

  const hasErrors = computed(() => summary.value.totalErrors > 0)

  const getRowErrors = computed(() => (rowId) =>
    validationErrors.value[rowId] || []
  )

  const isRowValid = computed(() => (rowId) =>
    !validationErrors.value[rowId] ||
    validationErrors.value[rowId].length === 0
  )

  // Column name mapping between different formats
  const columnMap = {
    'RESOURCE TYPE': 'resourceType',
    'RESOURCE NAME': 'resourceName',
    'SOURCE': 'source',
    'IDENTIFIER': 'identifier',
    'NEW/REUSE': 'newReuse',
    'ADDITIONAL INFORMATION': 'additionalInformation'
  }

  // Reverse mapping for lookups
  const reverseColumnMap = {
    'resourceType': 'RESOURCE TYPE',
    'resourceName': 'RESOURCE NAME',
    'source': 'SOURCE',
    'identifier': 'IDENTIFIER',
    'newReuse': 'NEW/REUSE',
    'additionalInformation': 'ADDITIONAL INFORMATION'
  }

  // Find matching row for a suggestion.
  //
  // Order matters here. Edit suggestions from the backend already carry the
  // exact KRT row id they target (`data.rowId`), so we trust that first.
  // Falling back to oldValue-equality is necessary for legacy/audit shapes
  // that don't have rowId — but it MUST come after the rowId lookup, because
  // oldValue equality is ambiguous for empty cells: every row with an empty
  // ADDITIONAL INFORMATION matches every suggestion whose oldValue is '',
  // collapsing distinct suggestions onto the first such row.
  function findMatchingRow(suggestion) {
    if (!suggestion.data) return null

    // Authoritative match: backend-emitted rowId.
    if (suggestion.data.rowId) {
      const found = rows.value.find(row => row.id === suggestion.data.rowId)
      if (found) return found
    }

    const col = suggestion.data.column
    const krtColumnKey = reverseColumnMap[col] || col

    // Fallback: oldValue equality. Only meaningful when oldValue is non-empty —
    // empty oldValue would match every blank cell of the same column.
    if (suggestion.data.oldValue !== undefined && String(suggestion.data.oldValue).trim() !== '') {
      const found = rows.value.find(row => {
        const cellValue = row[krtColumnKey] || ''
        const oldValue = suggestion.data.oldValue || ''
        return cellValue.trim() === oldValue.trim()
      })
      if (found) return found
    }

    // Last resort: resourceName substring match.
    if (suggestion.data.resourceName) {
      const found = rows.value.find(row => {
        const rowName = row['RESOURCE NAME'] || ''
        return rowName.toLowerCase().includes(suggestion.data.resourceName.toLowerCase())
      })
      if (found) return found
    }

    return null
  }

  // Get edit suggestions for a specific row - match by resource name/oldValue
  const getRowSuggestions = computed(() => (rowId) => {
    const targetRow = rows.value.find(r => r.id === rowId)
    if (!targetRow) return []

    return aiSuggestions.value.filter(s => {
      if (s.type !== 'edit' || s.status !== 'pending') return false
      const matchingRow = findMatchingRow(s)
      return matchingRow && matchingRow.id === rowId
    })
  })

  // Get cell-specific suggestion - match by resource name/oldValue for accuracy
  const getCellSuggestion = computed(() => (rowId, columnKey) => {
    const targetRow = rows.value.find(r => r.id === rowId)
    if (!targetRow) return null

    const fieldName = columnMap[columnKey] || columnKey

    return aiSuggestions.value.find(s => {
      if (s.type !== 'edit' || s.status !== 'pending') return false

      // Check if column matches
      const columnMatches = s.data?.column === columnKey ||
                            s.data?.column === fieldName ||
                            s.data?.column?.toLowerCase() === fieldName.toLowerCase()
      if (!columnMatches) return false

      // Find the row this suggestion is meant for
      const matchingRow = findMatchingRow(s)
      return matchingRow && matchingRow.id === rowId
    })
  })

  // Get add_row suggestions
  const addRowSuggestions = computed(() =>
    aiSuggestions.value.filter(s => s.type === 'add_row' && s.status === 'pending')
  )

  // Get delete_row suggestions
  const deleteRowSuggestions = computed(() =>
    aiSuggestions.value.filter(s => s.type === 'delete_row' && s.status === 'pending')
  )

  // Check if a row has a delete suggestion
  const getDeleteSuggestion = computed(() => (rowId) => {
    const targetRow = rows.value.find(r => r.id === rowId)
    if (!targetRow) return null

    return aiSuggestions.value.find(s => {
      if (s.type !== 'delete_row' || s.status !== 'pending') return false

      // Match by resourceName if provided
      if (s.data?.resourceName) {
        const rowName = targetRow['RESOURCE NAME'] || ''
        return rowName.toLowerCase().includes(s.data.resourceName.toLowerCase())
      }

      // Fallback to rowId
      return s.data?.rowId === rowId
    })
  })

  // Unique suggestion sources (for optional UI filtering)
  const suggestionSources = computed(() =>
    [...new Set(aiSuggestions.value.map(s => s.source).filter(Boolean))]
  )

  // Actions

  /**
   * Fetch KRT data for a submission
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Object>} - KRT data with rows and validation errors
   */
  async function fetchKRT(submissionId) {
    loading.value = true
    error.value = null

    try {
      const response = await krtService.getData(submissionId)
      rows.value = response.rows
      validationErrors.value = response.validationErrors
      // Preserve totalSuggestions when updating summary
      summary.value = {
        totalErrors: response.totalErrors,
        totalWarnings: response.totalWarnings,
        totalSuggestions: summary.value.totalSuggestions || 0
      }
      hasUnsavedChanges.value = false
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch KRT data'
      throw err
    } finally {
      loading.value = false
    }
  }

  /**
   * Upload a new KRT file for a submission
   * @param {string} submissionId - The submission ID
   * @param {File} file - The CSV/Excel file to upload
   * @returns {Promise<Object>} - Upload response
   */
  async function uploadKRT(submissionId, file) {
    loading.value = true
    error.value = null

    try {
      const response = await krtService.upload(submissionId, file)
      // Refresh data after upload
      await fetchKRT(submissionId)
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to upload KRT'
      throw err
    } finally {
      loading.value = false
    }
  }

  /**
   * Update a single cell
   * @param {string} submissionId - The submission ID
   * @param {string} rowId - The row UUID
   * @param {string} column - The column name
   * @param {string} value - The new value
   * @param {string} source - Change source: 'manual', 'ai_suggestion', or 'krt_validation'
   */
  async function updateCell(submissionId, rowId, column, value, source = 'manual') {
    try {
      // Single edits ride the batch endpoint with one item — one code path
      // for all cell writes (applyBatchResult refreshes rows + errors).
      const response = await krtService.batchUpdateRows(submissionId, {
        updates: [{ rowId, column, value }],
        source
      })

      await applyBatchResult(submissionId, response)

      return { row: response.rows.find(r => r.id === rowId) }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update cell'
      throw err
    }
  }

  /**
   * Batch update multiple cells — a single request for the whole gesture
   * (the old per-cell request loop tripped API rate limits on large KRTs).
   * @param {string} submissionId - The submission ID
   * @param {Array} updates - Array of { rowId, column, value }
   * @param {string} source - Change source for all updates (defaults to 'krt_validation' for batch ops)
   */
  async function batchUpdateCells(submissionId, updates, source = 'krt_validation') {
    loading.value = true
    error.value = null

    try {
      const response = await krtService.batchUpdateRows(submissionId, {
        updates,
        source
      })

      await applyBatchResult(submissionId, response)

      return { updatedCount: response.updated }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to batch update cells'
      throw err
    } finally {
      loading.value = false
    }
  }

  /**
   * Sync local state after a batch update. The endpoint already re-validated
   * the submission server-side, so use its summary directly and refetch the
   * KRT for per-row errors — no extra POST /validate round-trip.
   */
  async function applyBatchResult(submissionId, response) {
    for (const row of response.rows) {
      const rowIndex = rows.value.findIndex(r => r.id === row.id)
      if (rowIndex !== -1) {
        rows.value[rowIndex] = row
      }
    }
    if (response.validation) {
      summary.value = {
        totalErrors: response.validation.errorCount,
        totalWarnings: response.validation.warningCount,
        totalSuggestions: summary.value.totalSuggestions || 0
      }
    }
    // Refresh data to get updated per-row validation errors
    await fetchKRT(submissionId)
  }

  /**
   * Add a new row
   * @param {string} submissionId - The submission ID
   * @param {Object} data - Row data
   * @param {string} source - Change source: 'manual', 'ai_suggestion', or 'krt_validation'
   */
  async function addRow(submissionId, data, source = 'manual') {
    loading.value = true
    error.value = null

    try {
      const response = await krtService.addRow(submissionId, {
        ...data,
        changeSource: source // Backend expects 'changeSource' to avoid conflict with KRT source field
      })
      rows.value.push(response.row)
      hasUnsavedChanges.value = false

      // Re-validate
      await validate(submissionId)

      return response.row
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to add row'
      throw err
    } finally {
      loading.value = false
    }
  }

  /**
   * Delete a row
   * @param {string} submissionId - The submission ID
   * @param {string} rowId - The row UUID to delete
   * @param {string} source - Change source: 'manual', 'ai_suggestion', or 'krt_validation'
   */
  async function deleteRow(submissionId, rowId, source = 'manual') {
    loading.value = true
    error.value = null

    try {
      await krtService.deleteRow(submissionId, rowId, { source })

      // Remove from local state
      const rowIndex = rows.value.findIndex(r => r.id === rowId)
      if (rowIndex !== -1) {
        rows.value.splice(rowIndex, 1)
      }

      // Update validation errors
      delete validationErrors.value[rowId]

      // Re-validate to update errors for remaining rows
      await validate(submissionId)
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete row'
      throw err
    } finally {
      loading.value = false
    }
  }

  /**
   * Merge several rows into one (request G2). Backend deletes the originals
   * and creates the merged row in a single transaction; we then refetch.
   * @param {string} submissionId
   * @param {string[]} rowIds
   * @param {Object} merged - merged row values
   */
  async function mergeRows(submissionId, rowIds, merged) {
    loading.value = true
    error.value = null
    try {
      const response = await krtService.mergeRows(submissionId, rowIds, merged)
      await validate(submissionId) // refetches rows + validation
      return response.row
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to merge rows'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function validate(submissionId) {
    loading.value = true
    validating.value = true
    error.value = null

    try {
      const response = await krtService.validate(submissionId)
      // Preserve totalSuggestions when updating summary
      summary.value = {
        totalErrors: response.errorCount,
        totalWarnings: response.warningCount,
        totalSuggestions: summary.value.totalSuggestions || 0
      }

      // Refresh data to get updated validation errors
      await fetchKRT(submissionId)

      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Validation failed'
      throw err
    } finally {
      loading.value = false
      validating.value = false
    }
  }

  function setEditingCell(rowId, column) {
    editingCell.value = { rowId, column }
  }

  function clearEditingCell() {
    editingCell.value = null
  }

  function clearKRT() {
    rows.value = []
    validationErrors.value = {}
    aiSuggestions.value = []
    editingCell.value = null
    hasUnsavedChanges.value = false
    summary.value = { totalErrors: 0, totalWarnings: 0, totalSuggestions: 0 }
  }

  // Set AI suggestions from PDF analysis findings
  function setAiSuggestions(findings) {
    aiSuggestions.value = findings || []
    summary.value.totalSuggestions = findings?.filter(f => f.status === 'pending').length || 0
  }

  // Update a suggestion status locally
  function updateSuggestionStatus(suggestionId, status) {
    const idx = aiSuggestions.value.findIndex(s => s.id === suggestionId)
    if (idx !== -1) {
      aiSuggestions.value[idx].status = status
      summary.value.totalSuggestions = aiSuggestions.value.filter(f => f.status === 'pending').length
    }
  }

  // Clear all suggestions
  function clearAiSuggestions() {
    aiSuggestions.value = []
    summary.value.totalSuggestions = 0
  }

  /**
   * Fetch AI suggestions from all sources (PDF analysis, software detection, etc.)
   * @param {string} submissionId - The submission ID
   * @returns {Promise<Array>} - AI suggestions
   */
  async function fetchAiSuggestions(submissionId) {
    try {
      const result = await suggestionService.getSuggestions(submissionId)
      setAiSuggestions(result.suggestions || [])
      return result.suggestions || []
    } catch (err) {
      // No suggestions yet - not an error condition
      return []
    }
  }

  return {
    // State
    rows,
    validationErrors,
    aiSuggestions,
    editingCell,
    hasUnsavedChanges,
    loading,
    validating,
    error,
    summary,
    // Getters
    rowCount,
    hasErrors,
    getRowErrors,
    isRowValid,
    getRowSuggestions,
    getCellSuggestion,
    addRowSuggestions,
    deleteRowSuggestions,
    getDeleteSuggestion,
    suggestionSources,
    // Actions
    fetchKRT,
    uploadKRT,
    updateCell,
    batchUpdateCells,
    addRow,
    deleteRow,
    mergeRows,
    validate,
    setEditingCell,
    clearEditingCell,
    clearKRT,
    setAiSuggestions,
    updateSuggestionStatus,
    clearAiSuggestions,
    fetchAiSuggestions
  }
})
