/**
 * File Utilities - Common file handling functions
 *
 * @module utils/file
 */

/**
 * Download a blob as a file
 * @param {Blob} blob - The blob to download
 * @param {string} filename - The filename for the download
 */
export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

/**
 * Get file extension from filename
 * @param {string} filename - The filename
 * @returns {string} - The file extension (lowercase, without dot)
 */
export function getFileExtension(filename) {
  if (!filename) return ''
  const parts = filename.split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

/**
 * Get human-readable file size
 * @param {number} bytes - File size in bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} - Formatted file size (e.g., "2.5 MB")
 */
export function formatFileSize(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i]
}

/**
 * Check if a file is a valid type
 * @param {File} file - The file to check
 * @param {string[]} allowedTypes - Array of allowed MIME types or extensions
 * @returns {boolean} - Whether the file is valid
 */
export function isValidFileType(file, allowedTypes) {
  if (!file || !allowedTypes?.length) return false

  const extension = getFileExtension(file.name)
  const mimeType = file.type

  return allowedTypes.some(type => {
    // Check MIME type
    if (type.includes('/')) {
      return mimeType === type
    }
    // Check extension (with or without dot)
    return extension === type.replace(/^\./, '')
  })
}

/**
 * Read a file as text
 * @param {File} file - The file to read
 * @returns {Promise<string>} - The file contents
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = (e) => reject(e)
    reader.readAsText(file)
  })
}

/**
 * Read a file as data URL (base64)
 * @param {File} file - The file to read
 * @returns {Promise<string>} - The data URL
 */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = (e) => reject(e)
    reader.readAsDataURL(file)
  })
}
