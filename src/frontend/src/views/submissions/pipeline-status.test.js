// @vitest-environment happy-dom
/**
 * The pipeline page's per-step badge, fed the shape the API actually sends.
 *
 * This page holds RAW jobs from the poller. It used to read
 * `job.outcomeState` — a field JobStatusPanel builds on its own view-model and
 * the API never sends — so the check silently never fired and a step whose
 * service had FAILED rendered as a green "done". Nobody noticed until a
 * `partial` step did the same.
 *
 * A unit test of the helper cannot catch that: the helper was right, the page
 * asked it the wrong question. So this mounts the page with an API-shaped job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const getJobs = vi.fn()
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } })
}))
vi.mock('@/services/job.service', () => ({ default: { getJobs: (...a) => getJobs(...a) } }))
vi.mock('@/services/config.service', () => ({
  default: {
    getPipeline: vi.fn().mockResolvedValue({
      nodes: [{ jobType: 'software_detection', dependsOn: [], stage: 0, gates: [], consumers: [] }],
      stageCount: 1
    })
  }
}))
vi.mock('@/services/submission.service', () => ({ default: { get: vi.fn().mockResolvedValue({}) } }))

import PipelineView from './PipelineView.vue'

/** A job exactly as GET /jobs returns it — nested outcome, no `outcomeState`. */
const apiJob = (outcomeState) => ({
  jobType: 'software_detection',
  status: 'complete',
  result: {
    status: { detected: true },
    counts: { unique: 18 },
    data: { meta: { uniqueCount: 18 } },
    service: { config: { state: 'on' }, outcome: { state: outcomeState, source: 'external', failReason: 'softcite_failed', externalError: 'Service error' } }
  }
})

async function mountPage(job) {
  getJobs.mockResolvedValue({ jobs: [job] })
  const wrapper = mount(PipelineView, {
    global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  await flushPromises()
  return wrapper
}

describe('the pipeline page badge', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('shows "partial" for a partly-complete step', async () => {
    const wrapper = await mountPage(apiJob('partial'))

    expect(wrapper.find('.pv-status.st-partial').exists()).toBe(true)
    expect(wrapper.find('.pv-status').text()).toBe('partial')
  })

  it('shows "failed" for a step whose service failed — not a green done', async () => {
    // The pre-existing bug, in its original form.
    const wrapper = await mountPage(apiJob('fail'))

    expect(wrapper.find('.pv-status.st-fail').exists()).toBe(true)
    expect(wrapper.find('.pv-status.st-done').exists()).toBe(false)
  })

  it('still shows "done" for a healthy step', async () => {
    const wrapper = await mountPage(apiJob('done'))

    expect(wrapper.find('.pv-status.st-done').exists()).toBe(true)
    expect(wrapper.find('.pv-status').text()).toBe('done')
  })

  it('counts a partial step in the summary line rather than as done', async () => {
    const wrapper = await mountPage(apiJob('partial'))

    const summary = wrapper.find('.pv-state').text()
    expect(summary).toMatch(/1 partly complete/)
    expect(summary).toMatch(/0 of 1 done/)
  })
})
