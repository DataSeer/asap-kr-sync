/**
 * Date Utilities - Common date formatting functions
 *
 * @module utils/date
 */

/**
 * Format a date to a localized string (e.g., "Jan 15, 2024")
 * @param {Date|string|number} date - Date to format
 * @param {Object} options - Intl.DateTimeFormat options
 * @returns {string} - Formatted date string
 */
export function formatDate(date, options = {}) {
  if (!date) return ''

  const defaultOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options
  }

  return new Date(date).toLocaleDateString('en-US', defaultOptions)
}

/**
 * Format a date with time (e.g., "Jan 15, 2024, 2:30 PM")
 * @param {Date|string|number} date - Date to format
 * @returns {string} - Formatted date/time string
 */
export function formatDateTime(date) {
  if (!date) return ''

  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * Format a date as relative time (e.g., "2 hours ago", "3 days ago")
 * @param {Date|string|number} date - Date to format
 * @returns {string} - Relative time string
 */
export function formatRelativeTime(date) {
  if (!date) return ''

  const now = new Date()
  const then = new Date(date)
  const diffMs = now - then
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) return 'just now'
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`

  return formatDate(date)
}

/**
 * Format a date as ISO date string (YYYY-MM-DD)
 * @param {Date|string|number} date - Date to format
 * @returns {string} - ISO date string
 */
export function formatISODate(date) {
  if (!date) return ''
  return new Date(date).toISOString().split('T')[0]
}
