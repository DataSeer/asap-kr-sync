// @vitest-environment happy-dom
/**
 * The one place pipeline issues are rendered.
 *
 * Five surfaces show this list. The last time a rule like it lived on the
 * client, the pipeline page asked for a field the API never sent and drew
 * failed steps as green ticks for weeks — so the component renders what the
 * server computed and derives nothing itself. These tests pin that, and pin the
 * words, because the words are what a user decides on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const retryJob = vi.fn()
const continueWithout = vi.fn()
vi.mock('@/services/job.service', () => ({
  default: {
    retryJob: (...a) => retryJob(...a),
    continueWithout: (...a) => continueWithout(...a)
  }
}))

import PipelineIssues from './PipelineIssues.vue'

const issue = (over = {}) => ({
  jobType: 'markdown_convert',
  kind: 'failure',
  decided: null,
  blocking: true,
  holding: ['datasets_detection', 'krt_grounding'],
  wouldSkip: [],
  producedOutput: false,
  detail: 'Converter returned 503',
  ...over
})

const mountIt = (issues, props = {}) => mount(PipelineIssues, {
  props: { submissionId: 'sub-1', issues, actionable: true, ...props }
})

describe('what it shows', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('shows nothing at all when the round is clean', () => {
    // The common case. A panel that is always there, saying "no problems",
    // becomes furniture nobody reads when there IS a problem.
    const wrapper = mountIt([])

    expect(wrapper.find('.pi-block').exists()).toBe(false)
  })

  it('names the step and what went wrong', () => {
    const wrapper = mountIt([issue()])

    expect(wrapper.text()).toContain('Markdown Convert failed')
    expect(wrapper.text()).toContain('Converter returned 503')
  })

  it('calls a partial what it is — not a failure', () => {
    // The module produced a real answer with one engine dead. Calling that
    // "failed" would send the user looking for a result that is right there.
    const wrapper = mountIt([issue({ kind: 'partial', producedOutput: true })])

    expect(wrapper.text()).toContain('ran with a problem')
    expect(wrapper.text()).not.toContain('failed')
  })

  it('distinguishes a run that completed while producing nothing', () => {
    const wrapper = mountIt([issue({ kind: 'unusable' })])

    expect(wrapper.text()).toContain('produced nothing usable')
  })

  it('says "paused" only when something is actually held', () => {
    const wrapper = mountIt([issue({ blocking: false, holding: [] })])

    expect(wrapper.text()).not.toMatch(/paused/i)
    expect(wrapper.text()).toMatch(/needs your attention/i)
  })
})

describe('what continuing would cost', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('names the steps that cannot run at all', () => {
    // The difference between "these will run with less" and "these cannot run"
    // is the whole reason Continue is not a gamble.
    const wrapper = mountIt([issue({ wouldSkip: ['datasets_detection', 'materials_detection'] })])

    expect(wrapper.text()).toContain('Datasets Detection')
    expect(wrapper.text()).toMatch(/will be skipped/i)
  })

  it('says "with less to work from" when they can still run', () => {
    const wrapper = mountIt([issue({ kind: 'partial', producedOutput: true, wouldSkip: [] })])

    expect(wrapper.text()).toMatch(/with less to work from/i)
    expect(wrapper.text()).not.toMatch(/skipped/i)
  })

  it('says so plainly when nothing is waiting', () => {
    const wrapper = mountIt([issue({ blocking: false, holding: [], wouldSkip: [] })])

    expect(wrapper.text()).toMatch(/nothing is waiting on it/i)
  })
})

describe('deciding', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('retries the step', async () => {
    retryJob.mockResolvedValue({ message: 'running again' })
    const wrapper = mountIt([issue()])

    await wrapper.find('.pi-retry').trigger('click')
    await flushPromises()

    expect(retryJob).toHaveBeenCalledWith('sub-1', 'markdown_convert')
  })

  it('carries on past it', async () => {
    continueWithout.mockResolvedValue({ message: 'continuing' })
    const wrapper = mountIt([issue()])

    await wrapper.find('.pi-continue').trigger('click')
    await flushPromises()

    expect(continueWithout).toHaveBeenCalledWith('sub-1', 'markdown_convert')
  })

  it('tells the page to refresh once something changed', async () => {
    retryJob.mockResolvedValue({})
    const wrapper = mountIt([issue()])

    await wrapper.find('.pi-retry').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('resolved')).toBeTruthy()
  })

  it('offers "continue past all" only when there is more than one', async () => {
    // Three degraded detectors is three questions blocking the same steps,
    // asked when the user is already annoyed.
    expect(mountIt([issue()]).find('.pi-all').exists()).toBe(false)
    expect(mountIt([issue(), issue({ jobType: 'software_detection' })]).find('.pi-all').exists()).toBe(true)
  })

  it('records "continue past all" against each step separately', async () => {
    // One press, but the record has to stay precise about what was decided.
    continueWithout.mockResolvedValue({})
    const wrapper = mountIt([issue(), issue({ jobType: 'software_detection' })])

    await wrapper.find('.pi-all').trigger('click')
    await flushPromises()

    expect(continueWithout).toHaveBeenCalledTimes(2)
    expect(continueWithout.mock.calls.map((c) => c[1]).sort())
      .toEqual(['markdown_convert', 'software_detection'])
  })

  it('offers nothing on a page that may not decide', () => {
    // Other pages report the problem and stop there. A page that says a thing
    // is wrong is worth having even when it cannot help — it is how someone
    // finds out.
    const wrapper = mountIt([issue()], { actionable: false })

    expect(wrapper.find('.pi-block').exists()).toBe(true)
    expect(wrapper.find('.pi-retry').exists()).toBe(false)
    expect(wrapper.find('.pi-continue').exists()).toBe(false)
  })
})

describe('decisions already made', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  const decided = issue({ decided: { at: '2026-08-22T12:00:00Z', byName: 'Nicolas' } })

  it('are not asked about again', () => {
    const wrapper = mountIt([decided])

    expect(wrapper.find('.pi-retry').exists()).toBe(false)
  })

  it('stay visible, with who made them', () => {
    // A report built without software detection looks exactly like one where
    // software detection found nothing. This is the only thing that tells them
    // apart.
    const wrapper = mountIt([decided])

    expect(wrapper.find('.pi-settled').text()).toContain('Nicolas')
    expect(wrapper.find('.pi-settled').text()).toContain('Markdown Convert')
  })

  it('are left out of the short form', () => {
    // Step pages show what still needs doing; the history belongs on the
    // pipeline page beside the results it explains.
    const wrapper = mountIt([decided], { compact: true })

    expect(wrapper.find('.pi-settled').exists()).toBe(false)
  })
})
