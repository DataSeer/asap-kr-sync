// @vitest-environment happy-dom
/**
 * No advice about a statement nobody has vouched for.
 *
 * The Availability check reports on a paragraph pulled out of the manuscript
 * automatically, and extraction gets it wrong often enough to matter. The
 * server already refuses to spend an LM call before somebody confirms the
 * statement — but the page had two ways around that, and both were live:
 *
 *   1. the LEGACY in-browser rules cost nothing to compute, so they rendered
 *      immediately: a page full of recommendations about a paragraph the author
 *      had never agreed was theirs, indistinguishable from the real thing;
 *   2. arriving on the page called `regenerate`, which goes through the MANUAL
 *      path — and that path deliberately skips the confirmation, because a
 *      person clicking a step by name has decided to run it. Merely opening a
 *      page is not that decision, so the gate never applied to the one route
 *      every author takes.
 *
 * And a third, worse: with no suggestions to show, the `v-else` tail of the
 * render chain was an ALL-CLEAR. An unconfirmed statement rendered as a green
 * "No issues found" — a pass from a check that had never run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const regenerate = vi.fn()
const getDas = vi.fn()
const fetchSubmission = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } }),
  useRouter: () => ({ push: vi.fn() })
}))
vi.mock('@/router', () => ({ setSubmissionTitle: vi.fn() }))
vi.mock('@/services/das-suggestions.service', () => ({
  default: {
    get: (...a) => getDas(...a),
    regenerate: (...a) => regenerate(...a)
  }
}))
vi.mock('@/services/job.service', () => ({ default: { getJobs: vi.fn().mockResolvedValue({ jobs: [] }) } }))

import AvailabilityView from './AvailabilityView.vue'
import { useSubmissionStore } from '@/stores/submission.store'
import { useKRTStore } from '@/stores/krt.store'

const A_STATEMENT = 'All data are available at Zenodo, DOI 10.5281/zenodo.1.'

async function mountPage({ confirmed = false, das = A_STATEMENT } = {}) {
  const submissionStore = useSubmissionStore()
  const krtStore = useKRTStore()

  submissionStore.currentSubmission = {
    id: 'sub-1',
    title: 'A paper',
    status: 'step_as',
    dataAvailabilityStatement: das,
    extractedDataAvailabilityStatement: das,
    dasConfirmedAt: confirmed ? '2026-08-22T10:00:00Z' : null
  }
  fetchSubmission.mockResolvedValue(submissionStore.currentSubmission)
  vi.spyOn(submissionStore, 'fetchSubmission').mockImplementation(fetchSubmission)
  vi.spyOn(krtStore, 'fetchKRT').mockResolvedValue([])
  vi.spyOn(krtStore, 'clearKRT').mockImplementation(() => {})

  const wrapper = mount(AvailabilityView, {
    global: {
      directives: { tooltip },
      stubs: {
        SubmissionHeader: true,
        LoadError: true,
        RouterLink: { template: '<a><slot /></a>' }
      }
    }
  })
  await flushPromises()
  return wrapper
}

describe('suggestions before the statement is confirmed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // "Never run" — the state a first arrival is in.
    getDas.mockResolvedValue({ status: 'none', suggestions: [], signals: null, meta: {} })
    regenerate.mockResolvedValue({ queued: true, jobId: 'j1' })
  })

  it('shows none — not even the free in-browser ones', async () => {
    const wrapper = await mountPage({ confirmed: false })

    expect(wrapper.findAll('.suggestions-list').length).toBe(0)
    expect(wrapper.find('.carousel-view').exists()).toBe(false)
  })

  it('does not render a green all-clear over a check that never ran', async () => {
    // The worst version of the bug: silence read as a pass.
    const wrapper = await mountPage({ confirmed: false })

    expect(wrapper.text()).not.toMatch(/No issues found/i)
  })

  it('explains what is missing, and offers the confirmation', async () => {
    const wrapper = await mountPage({ confirmed: false })

    const locked = wrapper.find('.das-locked')
    expect(locked.exists()).toBe(true)
    expect(locked.text()).toMatch(/confirm your statement/i)
    expect(locked.find('button').exists()).toBe(true)
  })

  it('does not start the check just because the page was opened', async () => {
    // regenerate() takes the manual path, which skips the confirmation on
    // purpose. Opening a page is not a decision to spend an LM call.
    await mountPage({ confirmed: false })

    expect(regenerate).not.toHaveBeenCalled()
  })

  it('asks for a statement when there is none to confirm', async () => {
    const wrapper = await mountPage({ confirmed: false, das: '' })

    expect(wrapper.find('.das-locked').text()).toMatch(/add your availability statement/i)
    expect(regenerate).not.toHaveBeenCalled()
  })
})

describe('once it is confirmed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getDas.mockResolvedValue({ status: 'none', suggestions: [], signals: null, meta: {} })
    regenerate.mockResolvedValue({ queued: true, jobId: 'j1' })
  })

  it('runs the check on arrival', async () => {
    await mountPage({ confirmed: true })

    expect(regenerate).toHaveBeenCalledWith('sub-1')
  })

  it('drops the locked panel', async () => {
    const wrapper = await mountPage({ confirmed: true })

    expect(wrapper.find('.das-locked').exists()).toBe(false)
  })
})

describe('clicking "Yes, check it"', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getDas.mockResolvedValue({ status: 'none', suggestions: [], signals: null, meta: {} })
  })

  it('shows a loader immediately, not the built-in rules', async () => {
    // The built-in rules run in the browser and filled in whenever the model's
    // check was not `complete` — which includes "has not started". So confirming
    // flashed a full set of recommendations, then replaced them with the
    // model's a poll later: two different answers about one statement, seconds
    // apart, with nothing to say which was which.
    const wrapper = await mountPage({ confirmed: false })
    const store = useSubmissionStore()
    let release
    vi.spyOn(store, 'confirmDas').mockReturnValue(new Promise((r) => { release = r }))

    await wrapper.find('.das-locked button').trigger('click')
    await flushPromises()

    // Mid-flight: the request has not answered yet.
    expect(wrapper.find('.das-loader').exists()).toBe(true)
    expect(wrapper.find('.suggestions-list').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/built-in checks/i)

    release({ dasConfirmedAt: 'now', checking: true })
    await flushPromises()
  })

  it('and no all-clear while it is still working', async () => {
    const wrapper = await mountPage({ confirmed: false })
    const store = useSubmissionStore()
    let release
    vi.spyOn(store, 'confirmDas').mockReturnValue(new Promise((r) => { release = r }))

    await wrapper.find('.das-locked button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toMatch(/No issues found/i)
    release({ dasConfirmedAt: 'now', checking: true })
    await flushPromises()
  })

  it('falls back to the built-in rules when the check has actually failed', async () => {
    // The fallback is not being removed — it is being confined to the case it
    // was written for.
    getDas.mockResolvedValue({ status: 'failed', suggestions: [], signals: null, meta: {} })
    const wrapper = await mountPage({ confirmed: true })

    expect(wrapper.text()).toMatch(/built-in checks/i)
    expect(wrapper.find('.das-loader').exists()).toBe(false)
  })
})

describe('Continue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    getDas.mockResolvedValue({ status: 'none', suggestions: [], signals: null, meta: {} })
    regenerate.mockResolvedValue({ queued: true, jobId: 'j1' })
  })

  /** The header is stubbed, so read the prop the page hands it. */
  const header = (wrapper) => wrapper.findComponent({ name: 'SubmissionHeader' })

  it('is blocked until the statement is confirmed', async () => {
    // Otherwise an author leaves this step having never confirmed, the check
    // never runs, and the report carries no availability review at all — a
    // silence they had no way to notice.
    const wrapper = await mountPage({ confirmed: false })

    expect(header(wrapper).props('canGoNext')).toBe(false)
    expect(header(wrapper).props('nextBlockedReason')).toMatch(/confirm your availability statement/i)
  })

  it('opens once it is confirmed', async () => {
    getDas.mockResolvedValue({ status: 'complete', suggestions: [], signals: null, meta: {} })
    const wrapper = await mountPage({ confirmed: true })

    expect(header(wrapper).props('canGoNext')).toBe(true)
  })

  it('is NOT blocked when there is no statement to confirm', async () => {
    // Nothing to confirm and nothing to check. Blocking here would be a dead
    // end with no way out of it.
    const wrapper = await mountPage({ confirmed: false, das: '' })

    expect(header(wrapper).props('canGoNext')).toBe(true)
  })

  it('is not blocked by the sentinel either', async () => {
    // "Not found" is what extraction writes when it found nothing; it is the
    // empty case wearing words.
    const wrapper = await mountPage({ confirmed: false, das: 'Not found' })

    expect(header(wrapper).props('canGoNext')).toBe(true)
  })
})
