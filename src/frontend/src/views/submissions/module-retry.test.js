// @vitest-environment happy-dom
/**
 * Retrying one blocked step.
 *
 * A RESTART re-runs this step and everything built on it; it lives on the
 * pipeline page, where several steps can be chosen together. This is the
 * narrower thing that comes up after an external service is fixed: the pipeline
 * is stuck behind one failure and what is wanted is to unblock it.
 *
 * The condition that makes running one step alone legitimate is not "did it
 * fail" but "has anything consumed the failure yet". While everything
 * downstream is still `waiting`, nothing was built on its absence, so nothing is
 * left stale. Once a later step HAS run, retrying alone would leave its result
 * built on the failure — which is a restart's job, and the button has to say so
 * rather than quietly vanish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const getJobs = vi.fn()
const retryJob = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1', type: 'markdown_convert' } })
}))
vi.mock('@/services/job.service', () => ({
  default: {
    getJobs: (...a) => getJobs(...a),
    retryJob: (...a) => retryJob(...a),
    getRuns: vi.fn().mockResolvedValue({ runCount: 1, runs: [] }),
    getRun: vi.fn(),
    getJobPrompts: vi.fn().mockResolvedValue({ prompts: [] })
  }
}))
vi.mock('@/services/config.service', () => ({
  default: {
    getPipeline: vi.fn().mockResolvedValue({
      nodes: [
        { jobType: 'markdown_convert', dependsOn: [], stage: 0, gates: [], reads: ['pdf'] },
        { jobType: 'datasets_detection', dependsOn: ['markdown_convert'], stage: 1, gates: [], reads: ['markdown'] },
        { jobType: 'krt_grounding', dependsOn: ['datasets_detection'], stage: 2, gates: [], reads: ['markdown'] }
      ]
    })
  }
}))
vi.mock('@/services/orcid.service', () => ({ default: { getAuthors: vi.fn().mockResolvedValue({ authors: [] }) } }))
vi.mock('@/services/markdown.service', () => ({ default: { getContent: vi.fn().mockResolvedValue({}) } }))
vi.mock('@/services/file.service', () => ({ default: { download: vi.fn(), getFiles: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/submission.service', () => ({
  default: { get: vi.fn().mockResolvedValue({ id: 'sub-1', currentRound: 1 }) }
}))
vi.mock('@/services/resourceTypes.service', () => ({
  default: { getResourceTypeNames: vi.fn().mockResolvedValue([]), getResourceTypes: vi.fn().mockResolvedValue([]) }
}))

import { useAuthStore } from '@/stores/auth.store'
import ModuleResultsView from './ModuleResultsView.vue'

const job = (jobType, status) => ({
  jobType, status, runNumber: 1, runCount: 1,
  result: { status: {}, counts: {}, data: {}, service: { config: { state: 'on' }, outcome: { state: status === 'failed' ? 'fail' : 'done' } } }
})

async function mountPage({ role = 'ds_annotator', jobs = [] } = {}) {
  setActivePinia(createPinia())
  useAuthStore().user = { id: 'u1', role, name: 'Someone' }
  getJobs.mockResolvedValue({ jobs, inputs: [] })

  const wrapper = mount(ModuleResultsView, {
    global: {
      directives: { tooltip },
      stubs: { RouterLink: { template: '<a><slot /></a>' }, MarkdownViewer: true, SubmissionFileLinks: true }
    }
  })
  await flushPromises()
  return wrapper
}

const retryButton = (wrapper) =>
  wrapper.findAll('button').find((b) => /retry|starting/i.test(b.text()))

describe('the retry button', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('is absent while the step is fine', async () => {
    // "Run it again" on a healthy step is a restart, and it is offered where
    // restarts are.
    const wrapper = await mountPage({ jobs: [job('markdown_convert', 'complete')] })

    expect(retryButton(wrapper)).toBeUndefined()
  })

  it('appears when the step failed and nothing has run past it', async () => {
    const wrapper = await mountPage({
      jobs: [
        job('markdown_convert', 'failed'),
        job('datasets_detection', 'waiting'),
        job('krt_grounding', 'waiting')
      ]
    })

    const button = retryButton(wrapper)
    expect(button).toBeTruthy()
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('runs only that step, changing nothing else', async () => {
    retryJob.mockResolvedValue({ message: 'markdown_convert is running again' })
    const wrapper = await mountPage({
      jobs: [job('markdown_convert', 'failed'), job('datasets_detection', 'waiting')]
    })

    await retryButton(wrapper).trigger('click')
    await flushPromises()

    expect(retryJob).toHaveBeenCalledWith('sub-1', 'markdown_convert')
  })

  it('is disabled — not hidden — once a later step has run', async () => {
    // "Why can I not retry this?" is the question. Hiding the control answers it
    // with silence; the disabled button carries the reason and points at the
    // restart that would work.
    const wrapper = await mountPage({
      jobs: [
        job('markdown_convert', 'failed'),
        job('datasets_detection', 'complete'),
        job('krt_grounding', 'waiting')
      ]
    })

    const button = retryButton(wrapper)
    expect(button).toBeTruthy()
    expect(button.attributes('disabled')).toBeDefined()
  })

  it('names the step that already ran, and where to go instead', async () => {
    const wrapper = await mountPage({
      jobs: [job('markdown_convert', 'failed'), job('datasets_detection', 'complete')]
    })

    // The tooltip directive stores its text on the element's binding; the page
    // renders it through v-tooltip, so assert on what the page computed.
    const reason = wrapper.vm.$.setupState.retryState.reason
    expect(reason).toContain('Datasets Detection')
    expect(reason).toMatch(/pipeline page/i)
  })

  it('is offered when the downstream rows do not exist yet', async () => {
    // A round that failed early has no rows for the steps below. Nothing can
    // have been built on the failure, so the safety condition holds — and
    // requiring the rows to exist would refuse the retry exactly when the
    // pipeline is most stuck.
    const wrapper = await mountPage({ jobs: [job('markdown_convert', 'failed')] })

    expect(retryButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('is offered to the author too', async () => {
    // Deliberate: `canRestartJobs` is "is signed in". The person waiting on a
    // stuck pipeline is usually the author, and the whole point of retry is
    // that they can unblock it once the service is back.
    const wrapper = await mountPage({
      role: 'author',
      jobs: [job('markdown_convert', 'failed'), job('datasets_detection', 'waiting')]
    })

    expect(retryButton(wrapper)).toBeTruthy()
  })
})
