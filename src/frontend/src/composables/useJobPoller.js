import { ref, onMounted, onUnmounted } from 'vue'
import jobService from '@/services/job.service'

const INITIAL_POLL_MS = 3000
const MAX_POLL_MS = 30000
const BACKOFF_FACTOR = 1.5
const MAX_POLL_DURATION_MS = 20 * 60 * 1000 // 20 minutes — stop polling after this

// 'cancelled' is a real terminal status (added via migration). Used to render
// "Cancelled" and to treat cancelled jobs as finished, distinct from failures.
export function isCancelledJob(job) {
  return job?.status === 'cancelled'
}
/**
 * Waiting reasons that mean "this belongs to a later step", not "this is stuck".
 *
 * A step the submission has not reached is not outstanding work for the step
 * the user is on — it has not been asked to run yet. Counting it would hold the
 * KRT and PDF steps' "all processes finished" gate shut for the whole session,
 * which is why the DAS check used to be kept out of the pipeline altogether.
 * The server names the reason, so the distinction is made where it is known
 * rather than guessed from the job type.
 */
export const FUTURE_STEP_REASONS = new Set(['availability_step'])

/** Is this job merely queued behind a step the user has not reached? */
export function isFutureStepJob(job) {
  return job?.status === 'waiting' && FUTURE_STEP_REASONS.has(job?.waitingReason)
}

// Terminal statuses: a job that will not change further.
export function isTerminalStatus(status) {
  return status === 'complete' || status === 'failed' || status === 'cancelled'
}

/**
 * Composable for polling background job status for a submission.
 * Fetches once on mount, then polls with exponential backoff while any job is running.
 * Fires callbacks only on status transitions observed during this session.
 *
 * @param {import('vue').Ref<string>|string} submissionId - Submission ID (ref or string)
 * @returns {Object} - { jobs, inputs, isAnyRunning, getJob, onJobComplete, onJobFailed, refresh }
 */
export function useJobPoller(submissionId) {
  const jobs = ref({})
  const isAnyRunning = ref(false)
  const fetchError = ref(null)
  /**
   * What the round is being processed from — one entry per frozen input, each
   * saying which version the run read and whether the live data has moved on.
   * This is what lets a page say "this used an earlier version of your data"
   * instead of showing a result beside inputs that no longer match it.
   */
  const inputs = ref([])

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
      fetchError.value = null
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
            // Skip failure callbacks for a deliberate user cancel — it isn't an
            // error, so we don't want the "analysis failed" toast to fire.
            if (job.status === 'failed' && !isCancelledJob(job) && failedCallbacks[type]) {
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
      inputs.value = data.inputs || []

      // Check if any jobs are still running. A job parked behind a step the
      // submission has not reached does not count — see isFutureStepJob.
      const running = Object.values(jobMap).some(
        j => !isFutureStepJob(j)
          && (j.status === 'waiting' || j.status === 'queued' || j.status === 'processing')
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
      // Swallowed for the poll loop's sake — a transient failure mid-run must
      // not stop the polling — but recorded, because `jobs` then stays `{}`
      // and every consumer renders twelve steps as "not started". That is the
      // same sentence the panel shows for a submission whose pipeline has
      // genuinely never run, so the panel reads as a fact about the
      // submission rather than as a page that could not reach the server.
      fetchError.value = error
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
      // `fetchJobs` may have called stopPolling() — on the duration cap, or
      // because nothing is running any more. Re-arming on `isAnyRunning` alone
      // ignored that: the cap logged its warning, cleared the timer, and this
      // callback immediately set a new one. Worse, stopPolling() nulls
      // pollStartTime, and startPolling (the only thing that sets it) is gated
      // on !pollTimer — so the cap could never fire again and a wedged job
      // polled for ever.
      if (pollTimer === null) return
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
    inputs,
    /** The last poll's failure, or null. Cleared by the next success. */
    fetchError,
    isAnyRunning,
    getJob,
    onJobComplete,
    onJobFailed,
    onJobPendingInput,
    refresh
  }
}
