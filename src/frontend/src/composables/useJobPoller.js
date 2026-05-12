import { ref, onMounted, onUnmounted } from 'vue'
import jobService from '@/services/job.service'

const INITIAL_POLL_MS = 3000
const MAX_POLL_MS = 30000
const BACKOFF_FACTOR = 1.5
const MAX_POLL_DURATION_MS = 20 * 60 * 1000 // 20 minutes — stop polling after this

/**
 * Composable for polling background job status for a submission.
 * Fetches once on mount, then polls with exponential backoff while any job is running.
 * Fires callbacks only on status transitions observed during this session.
 *
 * @param {import('vue').Ref<string>|string} submissionId - Submission ID (ref or string)
 * @returns {Object} - { jobs, isAnyRunning, getJob, onJobComplete, onJobFailed, refresh }
 */
export function useJobPoller(submissionId) {
  const jobs = ref({})
  const isAnyRunning = ref(false)

  let pollTimer = null
  let currentIntervalMs = INITIAL_POLL_MS
  let pollStartTime = null
  let previousStatuses = {}
  let isFirstFetch = true
  const completeCallbacks = {}
  const failedCallbacks = {}
  const pendingInputCallbacks = {}

  /**
   * Get the reactive job object for a given type
   * @param {string} type - Job type key
   * @returns {object|null}
   */
  function getJob(type) {
    return jobs.value[type] || null
  }

  /**
   * Register a callback for when a job type transitions to 'complete'
   * @param {string} type - Job type
   * @param {Function} cb - Callback receiving the job object
   */
  function onJobComplete(type, cb) {
    if (!completeCallbacks[type]) completeCallbacks[type] = []
    completeCallbacks[type].push(cb)
  }

  /**
   * Register a callback for when a job type transitions to 'failed'
   * @param {string} type - Job type
   * @param {Function} cb - Callback receiving the job object
   */
  function onJobFailed(type, cb) {
    if (!failedCallbacks[type]) failedCallbacks[type] = []
    failedCallbacks[type].push(cb)
  }

  /**
   * Register a callback for when a job type transitions to 'pending_input'
   * @param {string} type - Job type
   * @param {Function} cb - Callback receiving the job object
   */
  function onJobPendingInput(type, cb) {
    if (!pendingInputCallbacks[type]) pendingInputCallbacks[type] = []
    pendingInputCallbacks[type].push(cb)
  }

  async function fetchJobs() {
    const id = typeof submissionId === 'object' ? submissionId.value : submissionId
    if (!id) return

    try {
      const data = await jobService.getJobs(id)
      const jobMap = {}
      for (const job of data.jobs) {
        jobMap[job.jobType] = job
      }

      // Fire transition callbacks (skip first fetch to avoid spurious triggers)
      if (!isFirstFetch) {
        for (const [type, job] of Object.entries(jobMap)) {
          const prev = previousStatuses[type]
          if (prev && prev !== job.status) {
            if (job.status === 'complete' && completeCallbacks[type]) {
              completeCallbacks[type].forEach(cb => cb(job))
            }
            if (job.status === 'failed' && failedCallbacks[type]) {
              failedCallbacks[type].forEach(cb => cb(job))
            }
            if (job.status === 'pending_input' && pendingInputCallbacks[type]) {
              pendingInputCallbacks[type].forEach(cb => cb(job))
            }
          }
        }
      }

      // Save current statuses for next diff
      previousStatuses = {}
      for (const [type, job] of Object.entries(jobMap)) {
        previousStatuses[type] = job.status
      }

      isFirstFetch = false
      jobs.value = jobMap

      // Check if any jobs are still running
      const running = Object.values(jobMap).some(
        j => j.status === 'waiting' || j.status === 'queued' || j.status === 'processing'
      )
      isAnyRunning.value = running

      // Start or stop polling based on running state
      if (running && !pollTimer) {
        startPolling()
      } else if (running && pollTimer) {
        // Check max poll duration
        if (pollStartTime && (Date.now() - pollStartTime > MAX_POLL_DURATION_MS)) {
          console.warn('[useJobPoller] Max poll duration reached, stopping')
          stopPolling()
        }
      } else if (!running && pollTimer) {
        stopPolling()
      }
    } catch (error) {
      console.warn('[useJobPoller] Fetch error:', error?.message || error)
    }
  }

  function startPolling() {
    if (pollTimer) return
    pollStartTime = Date.now()
    currentIntervalMs = INITIAL_POLL_MS
    scheduleNextPoll()
  }

  function scheduleNextPoll() {
    pollTimer = setTimeout(async () => {
      await fetchJobs()
      // If still running, schedule next poll with backoff
      if (isAnyRunning.value) {
        currentIntervalMs = Math.min(currentIntervalMs * BACKOFF_FACTOR, MAX_POLL_MS)
        scheduleNextPoll()
      } else {
        pollTimer = null
        pollStartTime = null
      }
    }, currentIntervalMs)
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
      pollStartTime = null
      currentIntervalMs = INITIAL_POLL_MS
    }
  }

  function refresh() {
    // On manual refresh, reset backoff to poll fast again
    currentIntervalMs = INITIAL_POLL_MS
    return fetchJobs()
  }

  onMounted(() => {
    fetchJobs()
  })

  onUnmounted(() => {
    stopPolling()
  })

  return {
    jobs,
    isAnyRunning,
    getJob,
    onJobComplete,
    onJobFailed,
    onJobPendingInput,
    refresh
  }
}
