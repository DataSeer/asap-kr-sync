import { ref } from 'vue'

/**
 * Composable for managing modal state
 * @param {Object} options - Configuration options
 * @param {Function} options.onOpen - Callback when modal opens
 * @param {Function} options.onClose - Callback when modal closes
 * @returns {Object} - { isOpen, data, open, close, toggle }
 */
export function useModal(options = {}) {
  const isOpen = ref(false)
  const data = ref(null)

  function open(modalData = null) {
    data.value = modalData
    isOpen.value = true
    options.onOpen?.(modalData)
  }

  function close() {
    isOpen.value = false
    data.value = null
    options.onClose?.()
  }

  function toggle(modalData = null) {
    if (isOpen.value) {
      close()
    } else {
      open(modalData)
    }
  }

  return {
    isOpen,
    data,
    open,
    close,
    toggle
  }
}
