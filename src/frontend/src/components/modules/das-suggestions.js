/**
 * The DAS check's row model.
 *
 * The check is a fixed rulebook — the model only decides, per rule, whether it
 * APPLIES and why. So every rule produces a row whether it fired or not: a rule
 * that did not fire is a check that passed, and hiding it would leave a curator
 * unable to tell "we looked and it is fine" from "we never looked".
 *
 * Each rule renders as one block: a line of columns, then a full-width line
 * carrying the explanation and, where the rulebook offers one, the sentence the
 * author can paste into their statement.
 */

/** Rules that need action first; a passed check is not news. */
export const STATUS_ORDER = ['Action needed', 'Passed']

export const statusLabel = (s) => (s?.applies ? 'Action needed' : 'Passed')

/**
 * Severity colour, from the shared result-table palette.
 *
 * Only a rule that APPLIES carries its severity — a passed check is not a
 * warning about anything, and colouring it amber would make a clean statement
 * look like a problem.
 */
export function severityBadge(s) {
  if (!s?.applies) return 'rbadge-own'
  return s.severity === 'warning' ? 'rbadge-warning' : 'rbadge-datasets'
}

/**
 * Why the rule reached its verdict, in the words meant for a reader.
 *
 * A rule that applies explains itself through the rulebook's `message`; one
 * that does not carries `notApplicableReason` — either the model's own words or
 * the rulebook's default. Never empty, so the cell never reads as missing data.
 */
export function verdictReason(s) {
  if (!s) return ''
  return (s.applies ? s.reason : s.notApplicableReason) || ''
}

/**
 * Flatten the suggestion list into display rows.
 *
 * Rules that apply come first — that is the reading order a curator wants — and
 * within each group the rulebook's own order is kept, so the page does not
 * reshuffle between runs.
 *
 * @param {Array} suggestions - the DAS job's suggestion list
 * @returns {Array} one or two rows per rule, with block markers
 */
export function buildDasRows(suggestions) {
  const list = Array.isArray(suggestions) ? suggestions : []
  const ordered = [
    ...list.filter((s) => s?.applies),
    ...list.filter((s) => !s?.applies)
  ]

  const rows = []
  ordered.forEach((s, groupIndex) => {
    const detail = s?.applies ? (s.message || '') : ''
    const recommended = s?.applies ? (s.recommendedText || '') : ''
    const hasDetail = Boolean(detail || recommended)

    rows.push({
      key: `${s?.ruleId || 'rule'}-${groupIndex}`,
      ruleId: s?.ruleId || '',
      title: s?.title || s?.ruleId || 'Unnamed check',
      status: statusLabel(s),
      applies: Boolean(s?.applies),
      severity: s?.severity || 'info',
      badge: severityBadge(s),
      reason: verdictReason(s),
      groupIndex,
      isGroupStart: true,
      isGroupEnd: !hasDetail
    })

    if (hasDetail) {
      rows.push({
        key: `${s?.ruleId || 'rule'}-${groupIndex}-detail`,
        groupIndex,
        isDetail: true,
        detail,
        recommended,
        isGroupStart: false,
        isGroupEnd: true
      })
    }
  })

  return rows
}

/** Counts for the status chips. */
export function countByStatus(suggestions) {
  const list = Array.isArray(suggestions) ? suggestions : []
  return {
    'Action needed': list.filter((s) => s?.applies).length,
    Passed: list.filter((s) => s && !s.applies).length
  }
}

/**
 * Does this rule match the search box?
 *
 * Searches everything a reader can see, including the explanation and the
 * recommended sentence — the title alone is too little to find a rule by.
 */
export function dasMatchesSearch(s, term) {
  const q = String(term || '').trim().toLowerCase()
  if (!q) return true
  return [s?.title, s?.ruleId, statusLabel(s), verdictReason(s), s?.message, s?.recommendedText]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q))
}
