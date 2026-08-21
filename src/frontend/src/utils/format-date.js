/**
 * Dates, formatted once.
 *
 * There were six copies of `formatDate` across the views and they had already
 * drifted into two behaviours — three called `toLocaleDateString` (date only)
 * and two `toLocaleString` (date and time) — with nothing to say which a given
 * table was supposed to show. The shared `utils/` that would have held them was
 * dead code and got deleted, which is how the copies happened.
 *
 * Two functions, because there really are two cases, and naming them is the
 * point: `formatDate` for a column where the day is the fact, `formatDateTime`
 * where the moment matters (an audit trail, a file version, a run).
 */

/** Shown instead of a date we cannot read. Never "Invalid Date". */
const NO_DATE = '—'

/**
 * The day, in a form that does not depend on the reader's locale conventions
 * for ordering — "20 Aug 2026", never "8/20/26" vs "20/8/26".
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string}
 */
export function formatDate(value) {
  const date = toDate(value)
  if (!date) return NO_DATE
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The day and the time, for anywhere the moment is the point: when a run
 * happened, when a file was uploaded, when a submission arrived. Two rows
 * created the same day are otherwise indistinguishable, and the order they are
 * listed in is the only clue about which came first.
 *
 * 24-hour, for the same reason as the month name: it does not depend on which
 * side of an ocean the reader is on.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string}
 */
export function formatDateTime(value) {
  const date = toDate(value)
  if (!date) return NO_DATE
  return `${formatDate(date)}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * A Date, or null when the input cannot be one.
 *
 * `new Date(undefined)` is an Invalid Date, and every copy of this function
 * rendered that straight into the page as the literal text "Invalid Date" —
 * which reads like a data problem rather than a missing value.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
