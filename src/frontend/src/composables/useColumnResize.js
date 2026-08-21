import { ref, onScopeDispose } from 'vue'

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

  /** Has the user dragged anything in this table? */
  function hasCustomWidths(ns, cols) {
    return cols.some((c) => typeof widths.value[cellKey(ns, c.key)] === 'number')
  }

  /**
   * Inline style for the table.
   *
   * Until something is dragged the table is 100% wide, so the columns share the
   * space available and nothing scrolls sideways on first view — the per-column
   * widths act as proportions rather than absolutes.
   *
   * After a drag it becomes an explicit total, which is what makes a widened
   * column push the table wider instead of squashing its neighbours. That is
   * the point of dragging, and it is only wanted once the user has asked for it.
   */
  function tableStyle(ns, cols) {
    if (!hasCustomWidths(ns, cols)) return { width: '100%' }
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

  // A drag attaches window listeners that only onEnd removes. If the component
  // goes away mid-drag — a modal closing, a route change — they outlived it and
  // kept writing to a detached ref. onScopeDispose rather than onUnmounted so
  // this also works when the composable is used outside a component setup.
  onScopeDispose(() => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onEnd)
  })

  return { headStyle, tableStyle, startResize, hasCustomWidths }
}
