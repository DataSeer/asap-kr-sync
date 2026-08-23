// @vitest-environment happy-dom
/**
 * "This analysis used an earlier version of your data."
 *
 * Every step in a round now reads one PDF, one converted manuscript and one
 * KRT — the first step to need each freezes it, and the rest are handed the
 * same one. That consistency has a consequence that has to be said out loud:
 * when the live document moves on, the results describe the older one.
 *
 * Without the note, an author reads an analysis of a manuscript they have
 * already replaced as though it were about the current version. The old
 * behaviour was worse still — steps silently read different versions of the
 * same document within one run, and nothing anywhere said so.
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

const JOB = { jobType: 'software_detection', status: 'complete', result: {} }

async function mountPage(inputs) {
  getJobs.mockResolvedValue({ jobs: [JOB], inputs })
  const wrapper = mount(PipelineView, {
    global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  await flushPromises()
  return wrapper
}

describe('the earlier-version note', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('stays away when the round is reading what is current', async () => {
    const wrapper = await mountPage([
      { inputKind: 'pdf', version: 2, liveVersion: 2, stale: false },
      { inputKind: 'krt', rowCount: 12, liveRowCount: 12, stale: false }
    ])

    expect(wrapper.find('.pv-stale').exists()).toBe(false)
  })

  it('names the document that moved on, and both versions', async () => {
    // "Something changed" is not actionable. Which document, and how far behind,
    // is what tells the author whether to restart anything.
    const wrapper = await mountPage([
      { inputKind: 'pdf', version: 1, liveVersion: 3, stale: true },
      { inputKind: 'krt', rowCount: 12, liveRowCount: 12, stale: false }
    ])

    const note = wrapper.find('.pv-stale')
    expect(note.exists()).toBe(true)
    expect(note.text()).toMatch(/earlier version of your data/i)
    expect(note.text()).toMatch(/manuscript PDF/)
    expect(note.text()).toMatch(/version 1 when this ran, version 3 now/)
  })

  it('counts rows for the KRT, which has no version', async () => {
    const wrapper = await mountPage([
      { inputKind: 'krt', rowCount: 12, liveRowCount: 15, stale: true }
    ])

    expect(wrapper.find('.pv-stale').text()).toMatch(/12 rows when this ran, 15 now/)
  })

  it('lists every input that changed, not just the first', async () => {
    const wrapper = await mountPage([
      { inputKind: 'pdf', version: 1, liveVersion: 2, stale: true },
      { inputKind: 'krt', rowCount: 12, liveRowCount: 15, stale: true }
    ])

    const text = wrapper.find('.pv-stale').text()
    expect(text).toMatch(/manuscript PDF/)
    expect(text).toMatch(/Key Resources Table/)
  })

  it('says nothing when the API sends no input information', async () => {
    // An older API, or a describe() that failed — either way the page must not
    // invent a claim about provenance it does not have.
    const wrapper = await mountPage(undefined)

    expect(wrapper.find('.pv-stale').exists()).toBe(false)
  })
})
