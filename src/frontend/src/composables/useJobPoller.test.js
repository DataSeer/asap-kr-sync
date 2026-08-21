// @vitest-environment happy-dom
/**
 * The job poller: when it asks again, when it gives up, and what it announces.
 *
 * Two failure modes matter, and neither throws:
 *
 *   - it never stops. The 20-minute cap cleared the timer, and the timer
 *     callback re-armed it anyway on `isAnyRunning` alone; because stopPolling
 *     nulls `pollStartTime` while only startPolling sets it, the cap could then
 *     never fire again. A wedged job polled for the lifetime of the tab.
 *   - it announces the wrong thing. The transition callbacks drive toasts and
 *     data refreshes, so firing on a first fetch would announce work the user
 *     never saw start, and firing "failed" on a cancel tells them something
 *     broke when they stopped it themselves.
 *
 * Timers are faked, so "twenty minutes" costs nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

const getJobs = vi.fn()
vi.mock('@/services/job.service', () => ({ default: { getJobs: (...a) => getJobs(...a) } }))

const { useJobPoller, isFutureStepJob } = await import('./useJobPoller')

const job = (jobType, status) => ({ jobType, status })
const reply = (...jobs) => ({ jobs })

/** Mount a component that just runs the composable, and hand back its API. */
function mountPoller(submissionId = 'sub-1') {
  let api
  const wrapper = mount(defineComponent({
    setup() {
      api = useJobPoller(submissionId)
      return () => h('div')
    }
  }))
  return { api, wrapper }
}

/** Let the mount fetch settle before assertions. */
const settle = async () => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => {
  vi.useFakeTimers()
  getJobs.mockReset()
  getJobs.mockResolvedValue(reply())
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('when it asks again', () => {
  it('fetches once on mount', async () => {
    const { wrapper } = mountPoller()
    await settle()
    expect(getJobs).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not poll when everything is already finished', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete')))
    const { wrapper } = mountPoller()
    await settle()

    await vi.advanceTimersByTimeAsync(120_000)

    expect(getJobs).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('polls while a job is running, backing off as it goes', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    const { wrapper } = mountPoller()
    await settle()
    expect(getJobs).toHaveBeenCalledTimes(1)

    // First interval is 3s: nothing at 2.9s, a fetch at 3s.
    await vi.advanceTimersByTimeAsync(2_900)
    expect(getJobs).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(getJobs).toHaveBeenCalledTimes(2)

    // Then 4.5s, not another 3s — the interval grows.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getJobs).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(getJobs).toHaveBeenCalledTimes(3)

    wrapper.unmount()
  })

  it('treats waiting and queued as running, not as finished', async () => {
    // A gated job is `waiting` — the pipeline is live and the user is watching
    // it, so the page must keep updating.
    for (const status of ['waiting', 'queued', 'processing']) {
      getJobs.mockResolvedValue(reply(job('datasets_detection', status)))
      const { api, wrapper } = mountPoller()
      await settle()
      expect(api.isAnyRunning.value, status).toBe(true)
      wrapper.unmount()
    }
  })

  it('treats complete, failed and cancelled as finished', async () => {
    for (const status of ['complete', 'failed', 'cancelled']) {
      getJobs.mockResolvedValue(reply(job('datasets_detection', status)))
      const { api, wrapper } = mountPoller()
      await settle()
      expect(api.isAnyRunning.value, status).toBe(false)
      wrapper.unmount()
    }
  })

  it('stops as soon as the last job finishes', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    const { wrapper } = mountPoller()
    await settle()

    await vi.advanceTimersByTimeAsync(3_000)
    expect(getJobs).toHaveBeenCalledTimes(2)

    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete')))
    await vi.advanceTimersByTimeAsync(4_500)
    const afterFinish = getJobs.mock.calls.length

    await vi.advanceTimersByTimeAsync(120_000)
    expect(getJobs).toHaveBeenCalledTimes(afterFinish)

    wrapper.unmount()
  })
})

describe('when it gives up', () => {
  it('stops after the twenty-minute cap, and stays stopped', async () => {
    // The regression: a job that never leaves `processing`. Before the fix the
    // cap cleared the timer, the callback re-armed it, and — pollStartTime now
    // null — the cap could never fire again.
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { wrapper } = mountPoller()
    await settle()

    await vi.advanceTimersByTimeAsync(21 * 60 * 1000)
    const atCap = getJobs.mock.calls.length
    expect(atCap).toBeGreaterThan(5)

    // Another hour must produce nothing at all.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(getJobs).toHaveBeenCalledTimes(atCap)

    wrapper.unmount()
  })

  it('stops when the component goes away', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    const { wrapper } = mountPoller()
    await settle()

    wrapper.unmount()
    const atUnmount = getJobs.mock.calls.length

    await vi.advanceTimersByTimeAsync(120_000)
    expect(getJobs).toHaveBeenCalledTimes(atUnmount)
  })

  it('keeps polling through a failed request rather than dying on it', async () => {
    // A transient 500 must not end the session's updates.
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { wrapper } = mountPoller()
    await settle()

    getJobs.mockRejectedValueOnce(new Error('network'))
    await vi.advanceTimersByTimeAsync(3_000)
    const afterError = getJobs.mock.calls.length

    await vi.advanceTimersByTimeAsync(10_000)
    expect(getJobs.mock.calls.length).toBeGreaterThan(afterError)

    wrapper.unmount()
  })
})

describe('what it announces', () => {
  it('says nothing on the first fetch', async () => {
    // Otherwise opening a page whose run finished yesterday fires "complete"
    // for every step at once.
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete')))
    const onComplete = vi.fn()
    let api
    const wrapper = mount(defineComponent({
      setup() {
        api = useJobPoller('sub-1')
        api.onJobComplete('markdown_convert', onComplete)
        return () => h('div')
      }
    }))
    await settle()

    expect(onComplete).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('fires on the transition into complete, once', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    const onComplete = vi.fn()
    let api
    const wrapper = mount(defineComponent({
      setup() {
        api = useJobPoller('sub-1')
        api.onJobComplete('markdown_convert', onComplete)
        return () => h('div')
      }
    }))
    await settle()

    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete')))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0].status).toBe('complete')

    // It has stopped polling now, but even a manual refresh must not repeat it.
    await api.refresh()
    expect(onComplete).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('announces a job that parks awaiting input', async () => {
    getJobs.mockResolvedValue(reply(job('pdf_analysis', 'processing')))
    const onPending = vi.fn()
    let api
    const wrapper = mount(defineComponent({
      setup() {
        api = useJobPoller('sub-1')
        api.onJobPendingInput('pdf_analysis', onPending)
        return () => h('div')
      }
    }))
    await settle()

    getJobs.mockResolvedValue(reply(job('pdf_analysis', 'pending_input')))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(onPending).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not report a failure for a job the user cancelled', async () => {
    // Cancelling is not an error; the "analysis failed" toast would be a lie.
    getJobs.mockResolvedValue(reply(job('datasets_detection', 'processing')))
    const onFailed = vi.fn()
    let api
    const wrapper = mount(defineComponent({
      setup() {
        api = useJobPoller('sub-1')
        api.onJobFailed('datasets_detection', onFailed)
        return () => h('div')
      }
    }))
    await settle()

    getJobs.mockResolvedValue(reply(job('datasets_detection', 'cancelled')))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(onFailed).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does report a real failure', async () => {
    getJobs.mockResolvedValue(reply(job('datasets_detection', 'processing')))
    const onFailed = vi.fn()
    let api
    const wrapper = mount(defineComponent({
      setup() {
        api = useJobPoller('sub-1')
        api.onJobFailed('datasets_detection', onFailed)
        return () => h('div')
      }
    }))
    await settle()

    getJobs.mockResolvedValue(reply(job('datasets_detection', 'failed')))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(onFailed).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('reading the jobs back', () => {
  it('indexes jobs by type, and returns null for one that is absent', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete')))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.getJob('markdown_convert').status).toBe('complete')
    expect(api.getJob('nothing_like_this')).toBe(null)
    wrapper.unmount()
  })

  it('refresh re-fetches immediately rather than waiting out the backoff', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'processing')))
    const { api, wrapper } = mountPoller()
    await settle()
    const before = getJobs.mock.calls.length

    await api.refresh()

    expect(getJobs.mock.calls.length).toBe(before + 1)
    wrapper.unmount()
  })
})

describe('a step waiting for a later stage of the submission', () => {
  // The DAS check is gated to the Availability step. It IS a pipeline job — it
  // appears in `jobs` and on the pipeline page — but while it is parked behind
  // a stage the user has not reached it is not outstanding work, and counting
  // it would hold the KRT and PDF steps' "all processes finished" gate shut for
  // the whole session. That is why it used to be kept out of the pipeline
  // altogether; the rule now lives in the state, where it belongs.
  const gated = (jobType) => ({ jobType, status: 'waiting', waitingReason: 'availability_step' })

  it('is present in the jobs map like any other step', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete'), gated('das_suggestions')))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.getJob('das_suggestions')?.status).toBe('waiting')
    wrapper.unmount()
  })

  it('does NOT count as running', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete'), gated('das_suggestions')))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.isAnyRunning.value).toBe(false)
    wrapper.unmount()
  })

  it('does not keep the poller running on an otherwise finished pipeline', async () => {
    getJobs.mockResolvedValue(reply(job('markdown_convert', 'complete'), gated('das_suggestions')))
    const { wrapper } = mountPoller()
    await settle()
    const afterMount = getJobs.mock.calls.length

    await vi.advanceTimersByTimeAsync(120_000)

    expect(getJobs).toHaveBeenCalledTimes(afterMount)
    wrapper.unmount()
  })

  it('DOES count once it is actually running', async () => {
    // The exemption is for "parked behind a later stage", not for the job type.
    getJobs.mockResolvedValue(reply(
      job('markdown_convert', 'complete'),
      job('das_suggestions', 'processing')
    ))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.isAnyRunning.value).toBe(true)
    wrapper.unmount()
  })

  it('a step waiting for an ordinary reason still counts', async () => {
    // A detector held by the KRT gate is work the user can release right now,
    // on the step they are on — quite different from a step they have not
    // reached.
    getJobs.mockResolvedValue(reply(
      { jobType: 'datasets_detection', status: 'waiting', waitingReason: 'krt_validation' }
    ))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.isAnyRunning.value).toBe(true)
    wrapper.unmount()
  })

  it('a waiting step with no reason at all counts — silence is not an exemption', async () => {
    getJobs.mockResolvedValue(reply({ jobType: 'pdf_analysis', status: 'waiting' }))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.isAnyRunning.value).toBe(true)
    wrapper.unmount()
  })
})

describe('isFutureStepJob', () => {
  it('is true only for a WAITING job with a future-step reason', () => {
    expect(isFutureStepJob({ status: 'waiting', waitingReason: 'availability_step' })).toBe(true)
    expect(isFutureStepJob({ status: 'processing', waitingReason: 'availability_step' })).toBe(false)
    expect(isFutureStepJob({ status: 'waiting', waitingReason: 'krt_validation' })).toBe(false)
    expect(isFutureStepJob({ status: 'waiting' })).toBe(false)
    expect(isFutureStepJob(null)).toBe(false)
    expect(isFutureStepJob(undefined)).toBe(false)
  })
})

describe('when the request itself fails', () => {
  /**
   * An empty `jobs` map is not a neutral state: the panel renders every step
   * as "Not started", which is exactly what it shows for a pipeline that has
   * genuinely never run. The failure has to be visible to the caller or the
   * page reports a fact about the submission that it never learned.
   */
  it('records the failure instead of leaving an empty map to speak for it', async () => {
    getJobs.mockRejectedValue(new Error('Network Error'))
    const { api, wrapper } = mountPoller()
    await settle()

    expect(api.jobs.value).toEqual({})
    expect(api.fetchError.value).toBeInstanceOf(Error)
    wrapper.unmount()
  })

  it('does not throw out of the poll loop', async () => {
    getJobs.mockRejectedValue(new Error('Network Error'))
    const { api, wrapper } = mountPoller()
    await expect(settle()).resolves.toBeUndefined()
    await expect(api.refresh()).resolves.toBeUndefined()
    wrapper.unmount()
  })

  it('clears the failure as soon as a poll succeeds again', async () => {
    getJobs.mockRejectedValueOnce(new Error('Network Error'))
    const { api, wrapper } = mountPoller()
    await settle()
    expect(api.fetchError.value).toBeTruthy()

    getJobs.mockResolvedValue(reply(job('pdf_analysis', 'complete')))
    await api.refresh()

    expect(api.fetchError.value).toBeNull()
    expect(api.jobs.value.pdf_analysis.status).toBe('complete')
    wrapper.unmount()
  })

  it('keeps the last known state when a later poll fails — one blip is not amnesia', async () => {
    getJobs.mockResolvedValue(reply(job('pdf_analysis', 'processing')))
    const { api, wrapper } = mountPoller()
    await settle()

    getJobs.mockRejectedValue(new Error('Network Error'))
    await api.refresh()

    expect(api.jobs.value.pdf_analysis.status).toBe('processing')
    expect(api.fetchError.value).toBeTruthy()
    wrapper.unmount()
  })
})
