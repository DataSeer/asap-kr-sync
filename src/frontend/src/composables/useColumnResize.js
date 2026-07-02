import { ref } from 'vue'

/**
 * Drag-to-resize table columns, persisted to localStorage.
 *
 * Designed for `table-layout: fixed` tables: the width lives on each header
 * `<th>` (the column follows it — no per-cell styles needed) and the `<table>`
 * gets an explicit total width so growing a column scrolls horizontally instead
 * of squashing its neighbours.
 *
 * One instance can serve several tables by namespacing each column key, so a
 * single localStorage entry holds every modal table's widths:
 *
 *   const cols = useColumnResize('jobModal.columnWidths')
 *   <table :style="cols.tableStyle('authors', AUTHOR_COLS)">
 *     <th v-for="c in AUTHOR_COLS" :style="cols.headStyle('authors', c.key, c.width)">
 *       {{ c.label }}
 *       <span class="resize-handle" @mousedown.stop.prevent="cols.startResize('authors', c.key, c.width, $event)" />
 *
 * @param {string} storageKey  localStorage key for the persisted widths map.
 * @param {number} [minWidth]  smallest a column can be dragged to, in px.
 */
export function useColumnResize(storageKey, minWidth = 60) {
  const widths = ref(loadWidths())

  function loadWidths() {
    try { return JSON.parse(localStorage.getItem(storageKey)) || {} } catch { return {} }
  }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(widths.value)) } catch { /* ignore quota/serialization */ }
  }

  const cellKey = (ns, col) => `${ns}:${col}`

  /** Current width of a column — the dragged value, else the caller's fallback. */
  function widthOf(ns, col, fallback) {
    const w = widths.value[cellKey(ns, col)]
    return (typeof w === 'number' && w > 0) ? w : fallback
  }

  /** Inline style for a header cell (drives the whole column under fixed layout). */
  function headStyle(ns, col, fallback) {
    const w = widthOf(ns, col, fallback)
    return { width: w + 'px', minWidth: w + 'px' }
  }

  /** Inline style for the table: an explicit total width = sum of the columns. */
  function tableStyle(ns, cols) {
    const total = cols.reduce((sum, c) => sum + widthOf(ns, c.key, c.width), 0)
    return { width: total + 'px' }
  }

  let drag = null

  function startResize(ns, col, fallback, event) {
    const th = event.target.closest('th')
    drag = { key: cellKey(ns, col), startX: event.clientX, startWidth: th ? th.offsetWidth : fallback }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
  }
  function onMove(event) {
    if (!drag) return
    const w = Math.max(minWidth, drag.startWidth + (event.clientX - drag.startX))
    widths.value = { ...widths.value, [drag.key]: w }
  }
  function onEnd() {
    if (!drag) return
    drag = null
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onEnd)
    persist()
  }

  return { headStyle, tableStyle, startResize }
}
