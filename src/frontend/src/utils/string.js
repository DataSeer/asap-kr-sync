/**
 * String Utilities - Common string manipulation functions
 *
 * @module utils/string
 */

/**
 * Truncate a string to a maximum length with ellipsis
 * @param {string} str - The string to truncate
 * @param {number} maxLength - Maximum length
 * @param {string} suffix - Suffix to append (default: '...')
 * @returns {string} - Truncated string
 */
export function truncate(str, maxLength, suffix = '...') {
  if (!str || str.length <= maxLength) return str
  return str.slice(0, maxLength - suffix.length) + suffix
}

/**
 * Capitalize the first letter of a string
 * @param {string} str - The string to capitalize
 * @returns {string} - Capitalized string
 */
export function capitalize(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Convert a string to title case
 * @param {string} str - The string to convert
 * @returns {string} - Title case string
 */
export function titleCase(str) {
  if (!str) return ''
  return str
    .toLowerCase()
    .split(' ')
    .map(word => capitalize(word))
    .join(' ')
}

/**
 * Convert camelCase or snake_case to readable text
 * @param {string} str - The string to convert
 * @returns {string} - Human-readable string
 */
export function humanize(str) {
  if (!str) return ''
  return str
    .replace(/([A-Z])/g, ' $1') // Insert space before capitals
    .replace(/_/g, ' ')          // Replace underscores with spaces
    .replace(/\s+/g, ' ')        // Collapse multiple spaces
    .trim()
    .toLowerCase()
}

/**
 * Generate a slug from a string
 * @param {string} str - The string to slugify
 * @returns {string} - Slugified string
 */
export function slugify(str) {
  if (!str) return ''
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // Remove non-word chars
    .replace(/[\s_-]+/g, '-')   // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, '')    // Remove leading/trailing hyphens
}

/**
 * Check if a string is empty or only whitespace
 * @param {string} str - The string to check
 * @returns {boolean} - Whether the string is blank
 */
export function isBlank(str) {
  return !str || str.trim().length === 0
}

/**
 * Pluralize a word based on count
 * @param {number} count - The count
 * @param {string} singular - Singular form
 * @param {string} plural - Plural form (default: singular + 's')
 * @returns {string} - Pluralized word with count
 */
export function pluralize(count, singular, plural = null) {
  const form = count === 1 ? singular : (plural || singular + 's')
  return `${count} ${form}`
}
