/**
 * The AI Suggestions decision log, prepared for display.
 *
 * Shared between the page (which filters and counts) and the table (which
 * renders), because both need the same answer to "what kind of decision is
 * this, and which rows does it concern" — and two answers would eventually
 * disagree.
 */

/** Handles both decision objects ({action}) and raw suggestions ({type}). */
export function decisionLabel(item) {
  const a = item.action || item.type
  const map = {
    add: 'Add', skip: 'Skip', update: 'Update', remove: 'Remove',
    add_row: 'Add', edit: 'Update', delete_row: 'Remove', unreviewed: 'Unreviewed'
  }
  return map[a] || a || '—'
}

/** Resource type a decision belongs to — the author's row wins. */
export function decisionType(d) {
  return (d.authorRow && d.authorRow.resourceType)
    || (d.generatedRow && d.generatedRow.resourceType)
    || ''
}

/** The order decisions are listed in: what changes first, what did not last. */
export const DECISION_ORDER = ['Add', 'Update', 'Remove', 'Skip', 'Unreviewed']

/** Searches the decision AND both of its rows — a name may only be on one. */
export function decisionMatchesSearch(d, q) {
  if (!q) return true
  const fields = [d.action || d.type, d.reason || d.description, d.resourceName]
  for (const cells of [d.authorRow, d.generatedRow, d.row]) {
    if (cells) fields.push(...Object.values(cells))
  }
  return fields.some((f) => String(f ?? '').toLowerCase().includes(q))
}

/**
 * Expand decisions into the display rows underneath them:
 *  - the matched author row (skip / update / remove) is always shown,
 *  - the generated row joins it for add / update, so a change shows both sides.
 *
 * @param {Array} decisions already filtered and ordered by the caller
 * @returns {Array} rows carrying their decision, role and group index
 */
export function buildDecisionRows(decisions) {
  const out = []
  ;(decisions || []).forEach((d, gi) => {
    const action = d.action || d.type
    const isUpdate = action === 'update' || action === 'edit'
    const isAdd = action === 'add' || action === 'add_row'
    const entities = []
    if (d.authorRow) entities.push({ role: 'Author', side: 'author', cells: d.authorRow })
    if (d.generatedRow && (isAdd || isUpdate)) {
      entities.push({ role: 'Generated', side: 'generated', cells: d.generatedRow })
    }
    // A skip with no author match, or an older result: show the one row there is.
    if (entities.length === 0 && d.generatedRow) {
      entities.push({ role: 'Generated', side: 'generated', cells: d.generatedRow })
    }
    if (entities.length === 0) {
      const cells = d.row || {
        resourceName: d.resourceName || d.title || (d.data && d.data.resourceName) || ''
      }
      entities.push({ role: '', side: 'author', cells })
    }
    entities.forEach((e, ei) => {
      out.push({
        decision: d,
        decisionLabel: decisionLabel(d),
        role: e.role,
        side: e.side,
        cells: e.cells,
        changes: d.changes || null,
        groupIndex: gi,
        isGroupStart: ei === 0
      })
    })
  })
  return out
}
