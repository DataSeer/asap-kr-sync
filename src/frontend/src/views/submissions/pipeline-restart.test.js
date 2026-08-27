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
const restartProcesses = vi.fn()
const continueWithout = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } })
}))
vi.mock('@/services/job.service', () => ({
  default: {
    getJobs: (...a) => getJobs(...a),
    restartProcesses: (...a) => restartProcesses(...a),
    continueWithout: (...a) => continueWithout(...a)
  }
}))
vi.mock('@/services/config.service', () => ({
  default: {
    // Two detectors that SHARE a later step, which is the shape the batch
    // restart exists for: picked together, grounding runs once after both.
    getPipeline: vi.fn().mockResolvedValue({
      nodes: [
        { jobType: 'markdown_convert', dependsOn: [], stage: 0, gates: [], reads: ['pdf'], autoAdvances: true },
        { jobType: 'datasets_detection', dependsOn: ['markdown_convert'], stage: 1, gates: [], reads: ['markdown', 'krt'], autoAdvances: true },
        { jobType: 'materials_detection', dependsOn: ['markdown_convert'], stage: 1, gates: [], reads: ['markdown', 'krt'], autoAdvances: true },
        { jobType: 'krt_grounding', dependsOn: ['datasets_detection', 'materials_detection'], stage: 2, gates: [], reads: ['markdown', 'krt'], autoAdvances: true }
      ],
      stageCount: 3
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

    expect(wrapper.findAll('.pv-restart')).toHaveLength(4)
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

    expect(restartProcesses).not.toHaveBeenCalled()
  })

  it('runs it on confirm, as one request', async () => {
    restartProcesses.mockResolvedValue({ message: 'markdown_convert re-started' })
    const wrapper = await mountPage()
    await restartOn(wrapper, 'Markdown Convert').trigger('click')

    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    // `live` by default: the common restart is "I changed the prompt, run it
    // again", and defaulting to the frozen ones would make that do nothing.
    expect(restartProcesses).toHaveBeenCalledWith('sub-1', ['markdown_convert'], 'live')
    expect(wrapper.find('.restart-dialog').exists()).toBe(false)
  })

  it('can run with the settings those steps last used', async () => {
    // A restart already re-reads the round's frozen inputs but has always used
    // today's prompt and model — so a re-run that disagrees with the original
    // cannot be told apart from a prompt somebody edited in between, which is
    // exactly what a re-run is usually asked to settle.
    restartProcesses.mockResolvedValue({ message: 're-started', paramsSource: 'frozen' })
    const wrapper = await mountPage()
    await restartOn(wrapper, 'Markdown Convert').trigger('click')

    await wrapper.find('input[value="frozen"]').setValue()
    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(restartProcesses).toHaveBeenCalledWith('sub-1', ['markdown_convert'], 'frozen')
  })

  it('forgets the choice when the dialog is reopened', async () => {
    // A sticky `frozen` is the dangerous default: the next restart would
    // silently ignore the prompt the user had just edited.
    restartProcesses.mockResolvedValue({ message: 're-started' })
    const wrapper = await mountPage()

    await restartOn(wrapper, 'Markdown Convert').trigger('click')
    await wrapper.find('input[value="frozen"]').setValue()
    await wrapper.find('.restart-cancel').trigger('click')
    await flushPromises()

    await restartOn(wrapper, 'Markdown Convert').trigger('click')
    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(restartProcesses).toHaveBeenLastCalledWith('sub-1', ['markdown_convert'], 'live')
  })

  it('keeps the dialog open when the restart fails', async () => {
    // Closing it would look like the restart had been accepted.
    restartProcesses.mockRejectedValue({ response: { data: { error: 'queue is down' } } })
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

describe('choosing several steps', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  const pickOn = (wrapper, label) =>
    wrapper.findAll('.pv-card').find((c) => c.text().includes(label))?.find('.pv-pick')

  it('shows nothing until something is picked', async () => {
    const wrapper = await mountPage()

    expect(wrapper.find('.pv-selbar').exists()).toBe(false)
  })

  it('counts what is picked', async () => {
    const wrapper = await mountPage()

    await pickOn(wrapper, 'Markdown Convert').trigger('click')
    await pickOn(wrapper, 'Datasets Detection').trigger('click')

    expect(wrapper.find('.pv-selbar').text()).toContain('2')
  })

  it('picking is not restarting', async () => {
    // The whole point of a selection is that it is assembled before anything
    // runs. A tick that fired a restart would make picking the second step
    // impossible.
    const wrapper = await mountPage()

    await pickOn(wrapper, 'Markdown Convert').trigger('click')

    expect(restartProcesses).not.toHaveBeenCalled()
    expect(wrapper.find('.restart-dialog').exists()).toBe(false)
  })

  it('un-picks on a second click', async () => {
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Markdown Convert').trigger('click')

    await pickOn(wrapper, 'Markdown Convert').trigger('click')

    expect(wrapper.find('.pv-selbar').exists()).toBe(false)
  })

  it('sends the whole selection in one request', async () => {
    // Not a loop of single restarts: the first to finish would release the work
    // they share, which then runs and is thrown away by the next reset.
    restartProcesses.mockResolvedValue({ message: '2 steps re-started' })
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Markdown Convert').trigger('click')
    await pickOn(wrapper, 'Datasets Detection').trigger('click')

    await wrapper.find('.pv-selbar-go').trigger('click')
    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(restartProcesses).toHaveBeenCalledTimes(1)
    const [, jobTypes] = restartProcesses.mock.calls[0]
    expect([...jobTypes].sort()).toEqual(['datasets_detection', 'markdown_convert'])
  })

  it('says the shared work runs once, not once per step', async () => {
    // Told step by step, someone restarting two detectors reads "grounding will
    // re-run" twice and reasonably concludes it runs twice.
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Datasets Detection').trigger('click')
    await pickOn(wrapper, 'Materials Detection').trigger('click')

    await wrapper.find('.pv-selbar-go').trigger('click')

    const text = wrapper.find('.restart-dialog').text()
    expect(text).toMatch(/once/i)
    expect(text).toContain('KRT Grounding')
  })

  it('does not list a picked step as something the restart discards', async () => {
    // Grounding is downstream of the detectors. Picking it too must not put it
    // in both lists — "runs again" and "results replaced" read as opposites.
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Datasets Detection').trigger('click')
    await pickOn(wrapper, 'KRT Grounding').trigger('click')

    await wrapper.find('.pv-selbar-go').trigger('click')

    const lists = wrapper.findAll('.restart-list')
    expect(lists.length).toBe(1, 'only the "these run again" list — nothing left to discard')
    expect(lists[0].text()).toContain('KRT Grounding')
  })

  it('names what was picked rather than counting it', async () => {
    // "Restart 2 steps?" leaves the reader to remember which two they ticked,
    // on the one screen where being sure matters.
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Markdown Convert').trigger('click')
    await pickOn(wrapper, 'Datasets Detection').trigger('click')

    await wrapper.find('.pv-selbar-go').trigger('click')

    const text = wrapper.find('.restart-dialog').text()
    expect(text).toContain('Markdown Convert')
    expect(text).toContain('Datasets Detection')
  })

  it('clears the selection once the restart is accepted', async () => {
    // Leaving it ticked invites a second identical restart.
    restartProcesses.mockResolvedValue({ message: '2 steps re-started' })
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Markdown Convert').trigger('click')
    await pickOn(wrapper, 'Datasets Detection').trigger('click')
    await wrapper.find('.pv-selbar-go').trigger('click')

    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pv-selbar').exists()).toBe(false)
  })

  it('keeps the selection when the restart failed', async () => {
    // They picked those steps and nothing ran; making them pick again would be
    // the app losing their work.
    restartProcesses.mockRejectedValue({ response: { data: { error: 'queue is down' } } })
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Markdown Convert').trigger('click')
    await wrapper.find('.pv-selbar-go').trigger('click')

    await wrapper.find('.restart-go').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pv-selbar').exists()).toBe(true)
  })

  it('Clear empties it', async () => {
    const wrapper = await mountPage()
    await pickOn(wrapper, 'Markdown Convert').trigger('click')

    await wrapper.find('.pv-selbar-clear').trigger('click')

    expect(wrapper.find('.pv-selbar').exists()).toBe(false)
  })
})

describe('a paused pipeline', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  /** The server's own issue list — the page renders it, it does not derive it. */
  const conversionFailed = [{
    jobType: 'markdown_convert',
    kind: 'failure',
    decided: null,
    blocking: true,
    holding: ['datasets_detection', 'materials_detection', 'krt_grounding'],
    wouldSkip: ['datasets_detection', 'materials_detection'],
    producedOutput: false,
    detail: 'Converter returned 503'
  }]

  async function mountWithIssues(issues) {
    getJobs.mockResolvedValue({ jobs: [], inputs: [], issues })
    const auth = useAuthStore()
    Object.defineProperty(auth, 'canRestartJobs', { get: () => true, configurable: true })
    const wrapper = mount(PipelineView, {
      global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()
    return wrapper
  }

  it('shows the issue the server reported', async () => {
    const wrapper = await mountWithIssues(conversionFailed)

    const block = wrapper.find('.pi-block')
    expect(block.exists()).toBe(true)
    expect(block.text()).toMatch(/paused/i)
    expect(block.text()).toContain('Markdown Convert')
  })

  it('does not re-derive the pause from the jobs', async () => {
    // The page used to work it out from `blockedBy`, and undercounted. The
    // server computes it now, and the page renders exactly what it is given.
    const wrapper = await mountWithIssues([])

    expect(wrapper.find('.pi-block').exists()).toBe(false)
  })

  it('offers the decision right there', async () => {
    restartProcesses.mockClear()
    const wrapper = await mountWithIssues(conversionFailed)

    await wrapper.find('.pi-continue').trigger('click')
    await flushPromises()

    expect(continueWithout).toHaveBeenCalledWith('sub-1', 'markdown_convert')
    expect(restartProcesses).not.toHaveBeenCalled()
  })
})
