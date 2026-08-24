// @vitest-environment happy-dom
/**
 * The metadata editor does NOT touch the Availability Statement.
 *
 * It used to: the field was offered here, along with a prompt to confirm it,
 * so the pipeline could be unblocked from any step. That was withdrawn on
 * purpose. The statement is read, edited and confirmed on the Availability
 * step alone — the only page that shows the text the check will read and what
 * it reported about it.
 *
 * The rule this pins is narrow and worth keeping: saving metadata must not
 * carry a statement. Editing it clears the confirmation server-side, so a
 * modal that quietly submitted the field would withdraw a confirmation the
 * person never knew they were touching, three steps from where it is shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/services/demos.service', () => ({ default: { list: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: [] }) } }))

import EditMetadataModal from './EditMetadataModal.vue'
import { useSubmissionStore } from '@/stores/submission.store'


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

describe('the metadata editor and the Availability Statement', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('offers no field for the statement', () => {
    const wrapper = mountModal({ submission: { dataAvailabilityStatement: 'Data are at Zenodo.' } })
    expect(wrapper.text()).not.toContain('Data Availability Statement')
    expect(wrapper.html()).not.toContain('dataAvailabilityStatement')
  })

  it('offers no confirmation prompt, whatever state the statement is in', () => {
    for (const das of ['Data are at Zenodo.', 'Not found', '']) {
      const wrapper = mountModal({ submission: { dataAvailabilityStatement: das } })
      expect(wrapper.text(), das).not.toContain('Confirm')
    }
  })

  it('says nothing about extraction running — there is no field to protect', () => {
    const wrapper = mountModal({ jobs: { das_extraction: { status: 'processing' } } })
    expect(wrapper.text()).not.toContain('reading your manuscript for the Availability Statement')
    expect(wrapper.find('textarea[disabled]').exists()).toBe(false)
  })
})
