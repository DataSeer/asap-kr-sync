// @vitest-environment happy-dom
/**
 * Restarting a step from the map.
 *
 * The pipeline page is where someone looking at a step that failed — or that ran
 * before they replaced the manuscript — decides to run it again. Sending them
 * into the module page first to find the button made the map a read-only thing.
 *
 * The card is itself a link, which is the trap: a button inside it fires the
 * card's navigation too unless the click is both stopped and prevented, and the
 * symptom is that restarting a step throws you off the page you wanted to watch
 * it from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const getJobs = vi.fn()
const triggerConvert = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } })
}))
vi.mock('@/services/job.service', () => ({ default: { getJobs: (...a) => getJobs(...a) } }))
vi.mock('@/services/markdown.service', () => ({
  default: { triggerConvert: (...a) => triggerConvert(...a) }
}))
vi.mock('@/services/config.service', () => ({
  default: {
    getPipeline: vi.fn().mockResolvedValue({
      nodes: [
        { jobType: 'markdown_convert', dependsOn: [], stage: 0, gates: [], reads: ['pdf'], autoAdvances: true },
        { jobType: 'datasets_detection', dependsOn: ['markdown_convert'], stage: 1, gates: [], reads: ['markdown'], autoAdvances: true }
      ],
      stageCount: 2
    })
  }
}))
vi.mock('@/services/submission.service', () => ({ default: { get: vi.fn().mockResolvedValue({}) } }))

import PipelineView from './PipelineView.vue'
import { useAuthStore } from '@/stores/auth.store'

async function mountPage({ canRestartJobs = true } = {}) {
  getJobs.mockResolvedValue({ jobs: [], inputs: [] })
  const auth = useAuthStore()
  // The store computes this from the user's role; the page only asks the store.
  Object.defineProperty(auth, 'canRestartJobs', { get: () => canRestartJobs, configurable: true })

  const wrapper = mount(PipelineView, {
    global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  await flushPromises()
  return wrapper
}

const restartOn = (wrapper, label) =>
  wrapper.findAll('.pv-card').find((c) => c.text().includes(label))?.find('.pv-restart')

describe('restarting from the pipeline map', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('offers a restart on every step', async () => {
    const wrapper = await mountPage()

    expect(wrapper.findAll('.pv-restart')).toHaveLength(2)
  })

  it('asks first, naming what the restart carries with it', async () => {
    // Restarting the conversion resets the detector below it — the dialog is
    // the only place that says so before it happens.
    const wrapper = await mountPage()

    await restartOn(wrapper, 'Markdown Convert').trigger('click')

    const dialog = wrapper.find('.restart-dialog')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('Datasets Detection')
  })

  it('does not run anything until the dialog is confirmed', async () => {
    const wrapper = await mountPage()

    await restartOn(wrapper, 'Markdown Convert').trigger('click')

    expect(triggerConvert).not.toHaveBeenCalled()
  })

  it('runs it on confirm', async () => {
    triggerConvert.mockResolvedValue({ message: 'Markdown conversion re-started' })
    const wrapper = await mountPage()
    await restartOn(wrapper, 'Markdown Convert').trigger('click')

    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(triggerConvert).toHaveBeenCalledWith('sub-1')
    expect(wrapper.find('.restart-dialog').exists()).toBe(false)
  })

  it('keeps the dialog open when the restart fails', async () => {
    // Closing it would look like the restart had been accepted.
    triggerConvert.mockRejectedValue({ response: { data: { error: 'queue is down' } } })
    const wrapper = await mountPage()
    await restartOn(wrapper, 'Markdown Convert').trigger('click')

    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(wrapper.find('.restart-dialog').exists()).toBe(true)
  })

  it('is absent for a user who may not restart anything', async () => {
    const wrapper = await mountPage({ canRestartJobs: false })

    expect(wrapper.findAll('.pv-restart')).toHaveLength(0)
  })
})
