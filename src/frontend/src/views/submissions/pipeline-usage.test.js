// @vitest-environment happy-dom
/**
 * What the pipeline page says a document has cost — and what it must never say.
 *
 * Two rules hold this together, and both fail quietly if broken:
 *
 *   1. The figure is TOKENS. No currency, no rate, no "$" reaches the UI. What
 *      a token costs changes without the run changing, so a number derived from
 *      a rate card is one this app cannot stand behind.
 *   2. It is an ESTIMATE, and its gaps are named. A call that could not be
 *      measured, or a pass that reports nothing, is stated rather than absorbed
 *      into a total that then looks more complete than it is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const getJobs = vi.fn()
const getPipelineRuns = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } })
}))
vi.mock('@/services/job.service', () => ({
  default: {
    getJobs: (...a) => getJobs(...a),
    getPipelineRuns: (...a) => getPipelineRuns(...a)
  }
}))
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

const usage = (total, extra = {}) => ({
  byModel: { 'gemini-2.5-flash': { promptTokens: total, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0, totalTokens: total, calls: 1 } },
  promptTokens: total, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0,
  totalTokens: total, calls: 1, measuredCalls: 1, unmeasured: [], notCounted: [],
  ...extra
})

async function mountWith(runs) {
  getJobs.mockResolvedValue({ jobs: [{ jobType: 'software_detection', status: 'complete', result: {} }] })
  getPipelineRuns.mockResolvedValue({ runs })
  const wrapper = mount(PipelineView, {
    global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  await flushPromises()
  return wrapper
}

describe('the document token estimate', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('adds up every run of the round, because every re-run was paid for', async () => {
    const wrapper = await mountWith([{ usage: usage(1000) }, { usage: usage(500) }])

    const chip = wrapper.find('.pv-state-usage')
    expect(chip.exists()).toBe(true)
    // Digits only: the separator is the viewer's locale ("1,500" on CI, "1 500"
    // on a French machine), and the number is what this asserts.
    expect(chip.text().replace(/\D/g, '')).toContain('1500')
    expect(chip.text()).toContain('est.')
  })

  it('says nothing at all when nothing was recorded', async () => {
    // Runs older than the column, or a document whose steps called no model.
    // A zero would claim it was free, which is a different and wrong statement.
    const wrapper = await mountWith([{ usage: null }, { usage: null }])

    expect(wrapper.find('.pv-state-usage').exists()).toBe(false)
  })

  it('never shows a currency, only tokens', async () => {
    // The rule this page exists under. A rate card in the frontend would be
    // both wrong and impossible to keep current.
    const wrapper = await mountWith([{ usage: usage(1000) }])
    const text = wrapper.text()

    expect(text).not.toMatch(/[$€£]/)
    expect(text).not.toMatch(/\bUSD\b|\bEUR\b/)
    expect(text).toContain('tokens')
  })

  it('opens a dialog naming what it could not count', async () => {
    // The gaps used to live in a tooltip, where they could be read and not
    // copied. They belong in the dialog now, in selectable text.
    const wrapper = await mountWith([
      { usage: usage(1000, { notCounted: ['langextract'] }) },
      { usage: usage(500, { unmeasured: [{ reason: 'timeout', httpStatus: 408 }] }) }
    ])

    await wrapper.find('.pv-state-usage').trigger('click')
    await flushPromises()

    const text = wrapper.text()
    expect(text).toMatch(/langextract/)
    expect(text).toMatch(/timed out/)
    expect(text).toMatch(/may well have been charged/)
  })

  it('the estimate is a button, so it can be opened by keyboard too', async () => {
    const wrapper = await mountWith([{ usage: usage(1000) }])

    const el = wrapper.find('.pv-state-usage')
    expect(el.element.tagName).toBe('BUTTON')
    expect(el.attributes('type')).toBe('button')
  })

  it('the dialog stays shut until it is asked for', async () => {
    const wrapper = await mountWith([{ usage: usage(1000) }])

    expect(wrapper.find('.tu-dialog').exists()).toBe(false)
    await wrapper.find('.pv-state-usage').trigger('click')
    expect(wrapper.find('.tu-dialog').exists()).toBe(true)
  })

  it('survives a runs request that fails, because the pipeline matters more', async () => {
    getJobs.mockResolvedValue({ jobs: [{ jobType: 'software_detection', status: 'complete', result: {} }] })
    getPipelineRuns.mockRejectedValue(new Error('nope'))
    const wrapper = mount(PipelineView, {
      global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    })
    await flushPromises()

    expect(wrapper.find('.pv-state-usage').exists()).toBe(false)
    expect(wrapper.find('.pv-flow').exists()).toBe(true)
  })
})
