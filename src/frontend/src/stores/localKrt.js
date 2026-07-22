import { reactive } from 'vue'
import krtService from '@/services/krt.service'

/**
 * In-memory KRT "store" for the standalone validation page.
 *
 * It mirrors the public surface of the Pinia `useKRTStore` (state props +
 * function-getters + the actions KRTEditor calls), but holds every row on the
 * client and never persists anything. KRTEditor resolves its store via
 * `inject('krtStore')`, so a page can `provide('krtStore', createLocalKrt())`
 * to run the exact same editor UI against local data.
 *
 * Mutations happen locally, then rows are re-validated through the stateless
 * `POST /api/krt/validate` endpoint (no DB writes). The `submissionId` first
 * argument every action receives is intentionally ignored.
 */

// KRTEditor passes snake_case field names to updateCell/batchUpdateCells.
const FIELD_TO_COLUMN = {
  resource_type: 'RESOURCE TYPE',
  resource_name: 'RESOURCE NAME',
  source: 'SOURCE',
  identifier: 'IDENTIFIER',
  new_reuse: 'NEW/REUSE',
  additional_information: 'ADDITIONAL INFORMATION'
}

// addRow/mergeRows pass camelCase data objects.
const CAMEL_TO_COLUMN = {
  resourceType: 'RESOURCE TYPE',
  resourceName: 'RESOURCE NAME',
  source: 'SOURCE',
  identifier: 'IDENTIFIER',
  newReuse: 'NEW/REUSE',
  additionalInformation: 'ADDITIONAL INFORMATION'
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  // Fallback for the rare non-secure context — good enough for a client key.
  return 'row-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function blankRow(id) {
  return {
    id,
    'RESOURCE TYPE': '',
    'RESOURCE NAME': '',
    'SOURCE': '',
    'IDENTIFIER': '',
    'NEW/REUSE': '',
    'ADDITIONAL INFORMATION': ''
  }
}

export function createLocalKrt() {
  const store = reactive({
    // ── State (unwrapped props, matching Pinia setup-store exposure) ──
    rows: [],
    validationErrors: {},
    aiSuggestions: [],
    editingCell: null,
    hasUnsavedChanges: false,
    loading: false,
    validating: false,
    error: null,
    summary: { totalErrors: 0, totalWarnings: 0, totalSuggestions: 0 },

    // Suggestions never exist on the standalone page.
    addRowSuggestions: [],
    deleteRowSuggestions: [],
    suggestionSources: [],

    // Base name used for downloaded files; set by the view after upload.
    downloadBaseName: 'krt-validated',

    // ── Function-getters (called as methods, like Pinia function getters) ──
    getRowErrors(rowId) {
      return store.validationErrors[rowId] || []
    },
    isRowValid(rowId) {
      return !(store.validationErrors[rowId] && store.validationErrors[rowId].length)
    },
    getRowSuggestions() {
      return []
    },
    getCellSuggestion() {
      return null
    },
    getDeleteSuggestion() {
      return null
    },

    // ── Internal helpers ──
    applyValidation(res) {
      store.validationErrors = res.validationErrors || {}
      store.summary = {
        totalErrors: res.totalErrors || 0,
        totalWarnings: res.totalWarnings || 0,
        totalSuggestions: 0
      }
    },

    async revalidate() {
      store.validating = true
      store.loading = true
      store.error = null
      try {
        const res = await krtService.validateRows(store.rows)
        store.applyValidation(res)
        return { errorCount: store.summary.totalErrors, warningCount: store.summary.totalWarnings }
      } catch (err) {
        store.error = err.response?.data?.error || 'Validation failed'
        throw err
      } finally {
        store.validating = false
        store.loading = false
      }
    },

    /** Load rows + validation from a POST /api/krt/parse response. */
    loadFromParse(res) {
      store.rows = res.rows || []
      store.applyValidation(res)
    },

    // ── Contract actions (submissionId ignored) ──
    async fetchKRT() {
      return { rows: store.rows }
    },

    async updateCell(_submissionId, rowId, column, value) {
      const row = store.rows.find(r => r.id === rowId)
      if (!row) return {}
      if (column === 'is_qc') {
        row.isQc = !!value
      } else if (column === 'is_optional') {
        row.isOptional = !!value
      } else {
        row[FIELD_TO_COLUMN[column] || column] = value
      }
      await store.revalidate()
      return { row }
    },

    async batchUpdateCells(_submissionId, updates) {
      for (const u of updates) {
        const row = store.rows.find(r => r.id === u.rowId)
        if (!row) continue
        row[FIELD_TO_COLUMN[u.column] || u.column] = u.value
      }
      await store.revalidate()
      return { updatedCount: updates.length }
    },

    async addRow(_submissionId, data = {}) {
      const row = blankRow(newId())
      for (const [camel, key] of Object.entries(CAMEL_TO_COLUMN)) {
        if (data[camel] != null) row[key] = String(data[camel])
      }
      store.rows.push(row)
      await store.revalidate()
      return row
    },

    async deleteRow(_submissionId, rowId) {
      store.rows = store.rows.filter(r => r.id !== rowId)
      const next = { ...store.validationErrors }
      delete next[rowId]
      store.validationErrors = next
      await store.revalidate()
    },

    async deleteRows(_submissionId, rowIds) {
      const set = new Set(rowIds)
      store.rows = store.rows.filter(r => !set.has(r.id))
      await store.revalidate()
      return { deleted: rowIds.length }
    },

    async mergeRows(_submissionId, rowIds, merged = {}) {
      const set = new Set(rowIds)
      const firstIdx = store.rows.findIndex(r => set.has(r.id))
      const row = blankRow(newId())
      for (const [camel, key] of Object.entries(CAMEL_TO_COLUMN)) {
        if (merged[camel] != null) row[key] = String(merged[camel])
      }
      if (typeof merged.isQc === 'boolean') row.isQc = merged.isQc
      if (typeof merged.isOptional === 'boolean') row.isOptional = merged.isOptional
      const kept = store.rows.filter(r => !set.has(r.id))
      kept.splice(firstIdx < 0 ? kept.length : firstIdx, 0, row)
      store.rows = kept
      await store.revalidate()
      return row
    },

    async validate() {
      return store.revalidate()
    },

    setEditingCell(rowId, column) {
      store.editingCell = { rowId, column }
    },
    clearEditingCell() {
      store.editingCell = null
    },
    clearKRT() {
      store.rows = []
      store.validationErrors = {}
      store.summary = { totalErrors: 0, totalWarnings: 0, totalSuggestions: 0 }
      store.editingCell = null
    },

    // Suggestion actions are no-ops on the standalone page.
    setAiSuggestions() {},
    updateSuggestionStatus() {},
    clearAiSuggestions() {},
    async fetchAiSuggestions() {
      return []
    },

    // ── Download hooks consumed by KRTEditor.downloadKRT ──
    async download(_submissionId, format = 'csv') {
      return krtService.exportRows(store.rows, format, store.downloadBaseName)
    },
    getExportFilename(format = 'csv') {
      return `${store.downloadBaseName}.${format}`
    }
  })

  return store
}
