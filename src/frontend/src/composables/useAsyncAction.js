import { ref } from 'vue'
import { useNotificationStore } from '@/stores/notification.store'

/**
 * Composable for executing async operations with loading state and notifications
 * @param {Object} options - Configuration options
 * @param {string} options.successMessage - Message to show on success
 * @param {string} options.errorMessage - Default error message if no specific error
 * @param {Function} options.onSuccess - Callback on success
 * @param {Function} options.onError - Callback on error
 * @returns {Object} - { loading, execute }
 */
export function useAsyncAction(options = {}) {
  const loading = ref(false)
  const notificationStore = useNotificationStore()

  async function execute(asyncFn, overrideOptions = {}) {
    const {
      successMessage,
      errorMessage = 'Operation failed',
      onSuccess,
      onError,
      showSuccessNotification = true,
      showErrorNotification = true
    } = { ...options, ...overrideOptions }

    loading.value = true

    try {
      const result = await asyncFn()

      if (showSuccessNotification && successMessage) {
        notificationStore.success(successMessage)
      }

      if (onSuccess) {
        onSuccess(result)
      }

      return { success: true, data: result }
    } catch (error) {
      const message = error.response?.data?.error || errorMessage

      if (showErrorNotification) {
        notificationStore.error(message)
      }

      if (onError) {
        onError(error)
      }

      return { success: false, error }
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    execute
  }
}
