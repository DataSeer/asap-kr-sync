// @vitest-environment happy-dom
/**
 * Choosing which run the module page shows.
 *
 * The page renders everything from `job.result.data.*`, so selecting a run
 * swaps the whole page — tables, counts, status line and METADATA together.
 * That is only safe if two things hold:
 *
 *   - a past run is UNMISTAKABLY read-only, or someone selects run 2, watches
 *     it render, and reasonably concludes the pipeline is now using it;
 *   - authors never get the control, because the endpoint behind it is gated to
 *     the same audience as the other job internals. Hiding a control whose data
 *     is one URL away is decoration, not access control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const getRuns = vi.fn()
const getRun = vi.fn()
const getJobs = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1', type: 'identifier_detection' } })
}))
vi.mock('@/services/job.service', () => ({
  default: {
    getJobs: (...a) => getJobs(...a),
    getRuns: (...a) => getRuns(...a),
    getRun: (...a) => getRun(...a),
    getJobPrompts: vi.fn().mockResolvedValue({ prompts: [] })
  }
}))
vi.mock('@/services/config.service', () => ({
  default: { getPipeline: vi.fn().mockResolvedValue({ nodes: [] }) }
}))
vi.mock('@/services/orcid.service', () => ({ default: { getAuthors: vi.fn().mockResolvedValue({ authors: [] }) } }))
vi.mock('@/services/markdown.service', () => ({ default: { getContent: vi.fn().mockResolvedValue({}) } }))
vi.mock('@/services/file.service', () => ({ default: { download: vi.fn(), getFiles: vi.fn().mockResolvedValue([]) } }))
// The page fetches these on mount and swallows their failures, so the tests
// passed without them — while every run printed a wall of ECONNREFUSED. Mocked
// so the suite is hermetic and its output is readable.
vi.mock('@/services/submission.service', () => ({
  default: { get: vi.fn().mockResolvedValue({ id: 'sub-1', currentRound: 1 }) }
}))
vi.mock('@/services/resourceTypes.service', () => ({
  default: { getResourceTypeNames: vi.fn().mockResolvedValue([]), getResourceTypes: vi.fn().mockResolvedValue([]) }
}))

import { useAuthStore } from '@/stores/auth.store'
import ModuleResultsView from './ModuleResultsView.vue'

const jobFor = (runCount) => ({
  jobType: 'identifier_detection',
  status: 'complete',
  runNumber: runCount,
  runCount,
  result: { status: { detected: true }, counts: {}, data: { items: [] }, service: { config: { state: 'on' }, outcome: { state: 'done', source: 'external' } } }
})

const runRow = (n, isLatest) => ({
  runNumber: n, isLatest, status: 'complete', outcomeState: 'done',
  startedAt: '2026-08-21T10:00:00Z', completedAt: '2026-08-21T10:00:02Z',
  durationMs: 2000, retryCount: 0, triggerKind: 'manual', triggeredBy: { id: 'u1', name: 'Annotator' }
})

async function mountPage({ role = 'ds_annotator', runs = [] } = {}) {
  setActivePinia(createPinia())
  useAuthStore().user = { id: 'u1', role, name: 'Someone' }

  getJobs.mockResolvedValue({ jobs: [jobFor(runs.length || 1)] })
  getRuns.mockResolvedValue({ runCount: runs.length, runs })

  const wrapper = mount(ModuleResultsView, {
    global: {
      directives: { tooltip },
      stubs: { RouterLink: { template: '<a><slot /></a>' }, MarkdownViewer: true, SubmissionFileLinks: true }
    }
  })
  await flushPromises()
  return wrapper
}

describe('the run selector', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('is absent for an author, whatever the run count', async () => {
    const wrapper = await mountPage({ role: 'author', runs: [runRow(2, true), runRow(1, false)] })

    expect(wrapper.find('.mrv-runs-select').exists()).toBe(false)
    expect(getRuns).not.toHaveBeenCalled()
  })

  it('is absent when there has only ever been one run', async () => {
    // A selector offering one option is furniture.
    const wrapper = await mountPage({ runs: [runRow(1, true)] })

    expect(wrapper.find('.mrv-runs-select').exists()).toBe(false)
  })

  it('appears from the second run onward, newest first', async () => {
    const wrapper = await mountPage({ runs: [runRow(3, true), runRow(2, false), runRow(1, false)] })

    const options = wrapper.find('.mrv-runs-select').findAll('option')
    expect(options).toHaveLength(3)
    expect(options[0].text()).toMatch(/3 of 3 — latest/)
  })

  it('shows the latest run without fetching it — the poller already has it', async () => {
    await mountPage({ runs: [runRow(2, true), runRow(1, false)] })

    expect(getRun).not.toHaveBeenCalled()
  })
})

describe('viewing a past run', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const selectRun1 = async (wrapper) => {
    getRun.mockResolvedValue({
      run: { ...jobFor(2), runNumber: 1, isLatest: false, status: 'failed', result: { status: {}, data: { items: [] }, service: { outcome: { state: 'fail', failReason: 'external_failed_demo_disabled' } } } }
    })
    await wrapper.find('.mrv-runs-select').setValue('1')
    await flushPromises()
  }

  it('says so, in a bar that does not go away', async () => {
    const wrapper = await mountPage({ runs: [runRow(2, true), runRow(1, false)] })
    await selectRun1(wrapper)

    const bar = wrapper.find('.mrv-past')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('not the current result')
    expect(bar.text()).toMatch(/run 1 of 2/)
  })

  it('describes the SELECTED run, not the live one', async () => {
    // The live job is complete; run 1 failed. The status line must follow the
    // selection or the page contradicts itself.
    const wrapper = await mountPage({ runs: [runRow(2, true), runRow(1, false)] })
    await selectRun1(wrapper)

    expect(wrapper.find('.mrv-status').text()).toMatch(/did not produce a result|Failed/i)
  })

  it('offers a way back, which returns to the live job', async () => {
    const wrapper = await mountPage({ runs: [runRow(2, true), runRow(1, false)] })
    await selectRun1(wrapper)
    expect(wrapper.find('.mrv-past').exists()).toBe(true)

    await wrapper.find('.mrv-past-btn').trigger('click')
    await flushPromises()

    expect(wrapper.find('.mrv-past').exists()).toBe(false)
    expect(wrapper.find('.mrv-status').text()).toMatch(/completed/i)
  })

  it('shows no bar when the selected run IS the latest', async () => {
    const wrapper = await mountPage({ runs: [runRow(2, true), runRow(1, false)] })

    await wrapper.find('.mrv-runs-select').setValue('2')
    await flushPromises()

    expect(wrapper.find('.mrv-past').exists()).toBe(false)
  })

  it('stays on the current run when the fetch fails', async () => {
    const wrapper = await mountPage({ runs: [runRow(2, true), runRow(1, false)] })
    getRun.mockRejectedValue(new Error('gone'))

    await wrapper.find('.mrv-runs-select').setValue('1')
    await flushPromises()

    expect(wrapper.find('.mrv-past').exists()).toBe(false)
    expect(wrapper.find('.mrv-status').text()).toMatch(/completed/i)
  })
})
