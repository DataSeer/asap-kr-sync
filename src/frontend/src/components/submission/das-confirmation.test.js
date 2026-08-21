// @vitest-environment happy-dom
/**
 * Confirming the Availability Statement from the metadata editor.
 *
 * Two states this pins, both about not letting the app put words in the
 * author's mouth:
 *
 *   - while extraction is running the field is about to be overwritten, so
 *     typing into it is a trap — whatever is saved may or may not survive, and
 *     the author cannot tell which;
 *   - a statement the extractor wrote has nobody behind it, so the check that
 *     reports on it (in the author's name) waits for someone to say it is the
 *     right passage. Text a person typed needs no such prompt: writing it IS
 *     confirming it.
 *
 * The editor is reachable from every step on purpose, so both of these have to
 * work here and not only on the Availability page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/services/demos.service', () => ({ default: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: [] }) } }))

import EditMetadataModal from './EditMetadataModal.vue'
import { useSubmissionStore } from '@/stores/submission.store'

const CONFIRM_BTN = 'button[type="button"]'

function mountModal({ submission = {}, jobs = {} } = {}) {
  return mount(EditMetadataModal, {
    props: {
      show: true,
      submission: { id: 'sub-1', title: 'A paper', ...submission }
    },
    global: {
      provide: { submissionJobs: ref(jobs) },
      stubs: { Teleport: true }
    }
  })
}

/** The confirmation prompt, found by its copy rather than a styling class. */
function confirmPrompt(wrapper) {
  return wrapper.findAll(CONFIRM_BTN).find((b) => /confirm/i.test(b.text()))
}

describe('the metadata editor while extraction is running', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('says so, and stops the author typing into a field about to be replaced', () => {
    const wrapper = mountModal({ jobs: { das_extraction: { status: 'processing' } } })

    expect(wrapper.text()).toMatch(/reading your manuscript/i)
    expect(wrapper.find('textarea[disabled]').exists()).toBe(true)
  })

  it('is still reachable — the feature is not taken away', () => {
    // The whole point of the notice is that the editor stays open from every
    // step. Hiding the modal, or the field, would be the easy wrong fix.
    const wrapper = mountModal({ jobs: { das_extraction: { status: 'queued' } } })

    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('leaves the field alone once extraction has finished', () => {
    const wrapper = mountModal({
      submission: { dataAvailabilityStatement: 'Data are at Zenodo.' },
      jobs: { das_extraction: { status: 'complete' } }
    })

    expect(wrapper.text()).not.toMatch(/reading your manuscript/i)
    expect(wrapper.find('textarea[disabled]').exists()).toBe(false)
  })

  it('behaves normally with no job information at all', () => {
    // Most steps do not poll jobs, so the injection is absent. That must read
    // as "not running", not as "unknown, so disable everything".
    const wrapper = mount(EditMetadataModal, {
      props: { show: true, submission: { id: 'sub-1', dataAvailabilityStatement: 'Data are at Zenodo.' } },
      global: { stubs: { Teleport: true } }
    })

    expect(wrapper.find('textarea[disabled]').exists()).toBe(false)
  })
})

describe('the confirmation prompt', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('appears for a statement nobody has vouched for', () => {
    const wrapper = mountModal({ submission: { dataAvailabilityStatement: 'Data are at Zenodo.' } })

    expect(confirmPrompt(wrapper)).toBeTruthy()
  })

  it('is gone once it has been confirmed', () => {
    const wrapper = mountModal({
      submission: { dataAvailabilityStatement: 'Data are at Zenodo.', dasConfirmedAt: '2026-08-22T10:00:00Z' }
    })

    expect(confirmPrompt(wrapper)).toBeUndefined()
  })

  it('does not offer to confirm "Not found"', () => {
    // The sentinel is what extraction persists when it found nothing.
    // Confirming it would send the checker those two words to review.
    const wrapper = mountModal({ submission: { dataAvailabilityStatement: 'Not found' } })

    expect(confirmPrompt(wrapper)).toBeUndefined()
  })

  it('does not offer to confirm an empty statement', () => {
    const wrapper = mountModal({ submission: { dataAvailabilityStatement: '' } })

    expect(confirmPrompt(wrapper)).toBeUndefined()
  })

  it('waits for extraction to finish before asking', () => {
    // Asking about text that is seconds from being replaced would collect a
    // decision about the wrong words.
    const wrapper = mountModal({
      submission: { dataAvailabilityStatement: 'Data are at Zenodo.' },
      jobs: { das_extraction: { status: 'processing' } }
    })

    expect(confirmPrompt(wrapper)).toBeUndefined()
  })

  it('records the confirmation when clicked', async () => {
    const wrapper = mountModal({ submission: { dataAvailabilityStatement: 'Data are at Zenodo.' } })
    const store = useSubmissionStore()
    const confirmDas = vi.spyOn(store, 'confirmDas').mockResolvedValue({ dasConfirmedAt: 'now' })

    await confirmPrompt(wrapper).trigger('click')

    expect(confirmDas).toHaveBeenCalledWith('sub-1')
  })
})
