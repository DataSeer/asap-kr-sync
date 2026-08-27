/**
 * Retry, or continue without — the two answers an unresolved issue asks for.
 *
 * One implementation because there are now two surfaces that offer the choice:
 * the pipeline page's issue list, and the pipeline panel's own step tiles on
 * the Manuscript step, where the two used to be stacked one above the other
 * saying the same thing twice. Whichever the user clicks, the same call is made
 * and the same thing is recorded.
 */
import { ref } from 'vue'
import jobService from '@/services/job.service'
import { useNotificationStore } from '@/stores/notification.store'

/**
 * @param {import('vue').Ref<string>|(() => string)} submissionId
 * @returns {{ busy: import('vue').Ref<string|null>, act: Function }}
 */
export function useIssueDecision(submissionId) {
  const notificationStore = useNotificationStore()
  // Keyed by `${jobType}:${action}` so only the button that was pressed shows
  // its pending state — two issues on screen must not disable each other.
  const busy = ref(null)
  const idOf = () => (typeof submissionId === 'function' ? submissionId() : submissionId.value ?? submissionId)

  /**
   * @param {string} jobType
   * @param {'retry'|'continue'} action
   * @param {(payload: object) => void} [onResolved]
   */
  async function act(jobType, action, onResolved) {
    if (busy.value) return
    busy.value = `${jobType}:${action}`
    try {
      const id = idOf()
      const result = action === 'retry'
        ? await jobService.retryJob(id, jobType)
        : await jobService.continueWithout(id, jobType)
      notificationStore.info(result?.message || 'Done')
      onResolved?.({ jobType, action })
    } catch (err) {
      notificationStore.error(err.response?.data?.error || 'That did not work')
    } finally {
      busy.value = null
    }
  }

  return { busy, act }
}
