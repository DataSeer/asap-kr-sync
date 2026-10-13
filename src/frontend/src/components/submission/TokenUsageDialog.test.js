// @vitest-environment happy-dom
/**
 * The dialog exists because a tooltip cannot be copied.
 *
 * So the things worth testing are not "does it render" but: is the detail
 * actually there, does the copy button produce something worth pasting, and
 * does it still refuse to show money.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

import TokenUsageDialog from './TokenUsageDialog.vue'

const bucket = (over = {}) => ({
  promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 1, ...over
})

const usage = (byModel, over = {}) => ({
  byModel,
  promptTokens: Object.values(byModel).reduce((n, b) => n + b.promptTokens, 0),
  outputTokens: Object.values(byModel).reduce((n, b) => n + b.outputTokens, 0),
  thoughtTokens: Object.values(byModel).reduce((n, b) => n + b.thoughtTokens, 0),
  cachedTokens: Object.values(byModel).reduce((n, b) => n + b.cachedTokens, 0),
  totalTokens: Object.values(byModel).reduce((n, b) => n + b.totalTokens, 0),
  calls: Object.values(byModel).reduce((n, b) => n + b.calls, 0),
  measuredCalls: 1, unmeasured: [], notCounted: [], ...over
})

const RUNS = [
  {
    runNumber: 2, createdAt: '2026-09-28T16:46:00.000Z',
    usage: usage({ 'gemini-2.5-flash': bucket({ promptTokens: 13017, outputTokens: 254, thoughtTokens: 162, totalTokens: 13271 }) }),
    steps: [{ jobType: 'das_extraction', usage: usage({ 'gemini-2.5-flash': bucket({ totalTokens: 13271, calls: 1 }) }) }]
  },
  {
    runNumber: 1, createdAt: '2026-09-22T10:00:00.000Z',
    usage: usage({ 'gemini-2.5-pro': bucket({ promptTokens: 1000, outputTokens: 100, totalTokens: 1100 }) }),
    steps: []
  }
]

const open = (runs = RUNS) => mount(TokenUsageDialog, { props: { runs, open: true } })

describe('the token usage dialog', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows every run, oldest first, in the order they happened', () => {
    const wrapper = open()
    const heads = wrapper.findAll('.tu-run-head').map(h => h.text())

    expect(heads).toHaveLength(2)
    expect(heads[0]).toMatch(/Run 1/)
    expect(heads[1]).toMatch(/Run 2/)
  })

  it('splits by model, because two models are two prices', () => {
    const text = open().text()

    expect(text).toContain('gemini-2.5-flash')
    expect(text).toContain('gemini-2.5-pro')
  })

  it('breaks a run down by module', () => {
    expect(open().text()).toContain('das_extraction')
  })

  it('never shows a currency', () => {
    const text = open().text()

    expect(text).not.toMatch(/[$€£]/)
    expect(text).not.toMatch(/\bUSD\b|\bEUR\b/)
  })

  it('explains a failed call in words, not in our internal code', () => {
    // "timeout" is our label. What a reader needs is whether it was charged.
    const wrapper = open([{
      runNumber: 1, createdAt: '2026-09-28', steps: [],
      usage: usage({ 'gemini-2.5-flash': bucket({ totalTokens: 10 }) }, {
        unmeasured: [{ reason: 'timeout' }, { reason: 'rate_limited' }]
      })
    }])
    const text = wrapper.text()

    expect(text).toMatch(/may well have been charged/)
    expect(text).toMatch(/not charged/)
  })

  it('copies a plain-text version that carries the numbers', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const wrapper = open()
    await wrapper.find('.tu-copy').trigger('click')

    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0]
    expect(copied).toMatch(/Token usage \(estimate\)/)
    expect(copied).toMatch(/gemini-2\.5-flash/)
    expect(copied).toMatch(/das_extraction/)
    expect(copied).toMatch(/provider console is the authority/)
    expect(copied).not.toMatch(/[$€£]/)
  })

  it('a refused clipboard does not throw — the text is on screen anyway', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })

    const wrapper = open()
    await expect(wrapper.find('.tu-copy').trigger('click')).resolves.not.toThrow()
    expect(wrapper.find('.tu-copy').text()).toBe('Copy as text')
  })

  it('says why a document has no figure, rather than showing zero', () => {
    const wrapper = open([{ runNumber: 1, createdAt: '2026-09-01', usage: null, steps: [] }])

    expect(wrapper.find('.tu-empty').exists()).toBe(true)
    expect(wrapper.text()).toMatch(/did not cost nothing/)
  })

  it('counts the runs that recorded nothing, instead of pretending they did not happen', () => {
    // "across 1 run" on a document processed twice would be a quiet lie.
    const wrapper = open([
      { runNumber: 1, createdAt: '2026-09-22', usage: null, steps: [] },
      { runNumber: 2, createdAt: '2026-09-28', usage: usage({ 'gemini-2.5-flash': bucket({ totalTokens: 100 }) }), steps: [] }
    ])

    expect(wrapper.text()).toMatch(/1 earlier run/)
    expect(wrapper.text()).toMatch(/recorded no usage/)
  })

  it('shows a dash, not a zero, where a rebuilt run never measured', () => {
    // The old tally folded thinking into output without recording it, so those
    // runs did think — printing 0 would say otherwise.
    const wrapper = open([{
      runNumber: 1, createdAt: '2026-09-22', steps: [],
      usage: {
        ...usage({ 'gemini-2.5-flash': { promptTokens: 100, outputTokens: 50, thoughtTokens: null, cachedTokens: null, totalTokens: 150, calls: 1 } }),
        thoughtTokens: null, cachedTokens: null, backfilled: true
      }
    }])
    const text = wrapper.text()

    expect(text).toMatch(/reconstructed from what the old/)
    expect(wrapper.find('.tu-table tbody').text()).toContain('—')
  })

  it('shows a reused step, marked, without charging this run for it', () => {
    // A re-run lists every module — it carried the others forward. Hiding them
    // left a twelve-step pipeline itemised into one line; counting them
    // itemised a 100-token run into thousands. Neither is what happened.
    const only = usage({ 'gemini-2.5-flash': bucket({ totalTokens: 100 }) })
    const wrapper = open([{
      runNumber: 2, createdAt: '2026-09-28', usage: only,
      steps: [
        { jobType: 'das_extraction', carriedOver: false, usage: only },
        { jobType: 'software_detection', carriedOver: true, usage: usage({ 'gemini-2.5-flash': bucket({ totalTokens: 90000 }) }) }
      ]
    }])
    const rows = wrapper.findAll('.tu-steps tbody tr')

    expect(rows).toHaveLength(2)
    expect(wrapper.find('.tu-steps').text()).toContain('software_detection')
    expect(wrapper.find('.tu-reused-tag').exists()).toBe(true)
    // The 90 000 it originally cost belongs to the run that ran it, not here.
    expect(wrapper.find('.tu-steps').text()).not.toContain('90')
    expect(wrapper.find('.tu-reused-note').exists()).toBe(true)
  })

  it('copies the reused marker too, rather than a misleading number', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const only = usage({ 'gemini-2.5-flash': bucket({ totalTokens: 100 }) })

    const wrapper = open([{
      runNumber: 2, createdAt: '2026-09-28', usage: only,
      steps: [{ jobType: 'software_detection', carriedOver: true, usage: usage({ 'gemini-2.5-flash': bucket({ totalTokens: 90000 }) }) }]
    }])
    await wrapper.find('.tu-copy').trigger('click')

    expect(writeText.mock.calls[0][0]).toMatch(/software_detection: reused from an earlier run/)
  })

  it('does not state a thinking total when one run never measured it', async () => {
    // Run 2 thought 162 tokens; run 1's thinking was never recorded. "162
    // thinking" across both would be short by an unknown amount.
    const wrapper = open([
      { runNumber: 1, createdAt: '2026-09-22', steps: [],
        usage: { ...usage({ 'gemini-2.5-flash': { promptTokens: 100, outputTokens: 50, thoughtTokens: null, cachedTokens: null, totalTokens: 150, calls: 1 } }), thoughtTokens: null, cachedTokens: null, backfilled: true } },
      { runNumber: 2, createdAt: '2026-09-28', steps: [],
        usage: usage({ 'gemini-2.5-flash': bucket({ outputTokens: 200, thoughtTokens: 162, totalTokens: 200 }) }) }
    ])

    expect(wrapper.find('.tu-summary').text()).not.toMatch(/162 thinking/)
  })

  it('renders nothing at all when closed', () => {
    const wrapper = mount(TokenUsageDialog, { props: { runs: RUNS, open: false } })

    expect(wrapper.find('.tu-dialog').exists()).toBe(false)
  })
})
