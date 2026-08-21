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
