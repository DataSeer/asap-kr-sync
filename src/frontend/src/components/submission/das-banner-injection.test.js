// @vitest-environment happy-dom
/**
 * The Availability Statement banner is the only way a user learns that a step
 * is waiting on them, and it hangs off ONE injection — `submissionJobs`.
 *
 * The regression this guards: `provide('submissionJobs', jobs)` was moved out
 * of the view and into BackgroundProcesses, which is SubmissionHeader's
 * SIBLING. provide() only travels down, so the header silently fell back to
 * its `ref({})` default and the banner never showed. Nothing threw, nothing
 * logged — the pipeline just sat there.
 *
 * What the banner is ABOUT changed: the consolidator used to park waiting for a
 * statement it never read, which stalled the KRT half of the run behind a field
 * only the Availability step uses. Now the Availability check is the step that
 * waits, and it waits for a confirmation rather than for text to exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/services/file.service', () => ({ default: { getFiles: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/krt.service', () => ({ default: { getKRT: vi.fn().mockResolvedValue({}) } }))

import SubmissionHeader from './SubmissionHeader.vue'
import { useSubmissionStore } from '@/stores/submission.store'

const submission = { id: 'sub-1', title: 'A paper', status: 'processing' }

function mountHeader(jobs) {
  return mount(SubmissionHeader, {
    props: { submission, stepTitle: 'Step 3', stepDescription: '' },
    global: {
      provide: jobs ? { submissionJobs: ref(jobs) } : {},
      stubs: {
        StatusBadge: true, StepIndicator: true, EditMetadataModal: true,
        FilesInfoModal: true, StepHelpPanel: true, RouterLink: true
      }
    }
  })
}

describe('the Availability Statement confirmation banner', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('shows when the Availability check is waiting on a person', () => {
    const wrapper = mountHeader({ das_suggestions: { status: 'pending_input' } })
    expect(wrapper.find('.das-pending-banner').exists()).toBe(true)
  })

  it('stays hidden while the check is running normally', () => {
    const wrapper = mountHeader({ das_suggestions: { status: 'processing' } })
    expect(wrapper.find('.das-pending-banner').exists()).toBe(false)
  })

  it('does not key off the consolidator any more', () => {
    // pdf_analysis no longer has a condition that can park it, and if a future
    // edit gives it one, that is not this banner's business — the statement is
    // not its input.
    const wrapper = mountHeader({ pdf_analysis: { status: 'pending_input' } })
    expect(wrapper.find('.das-pending-banner').exists()).toBe(false)
  })

  it('stays hidden without the injection — the failure the sibling-provide caused', () => {
    const wrapper = mountHeader(null)   // header mounted with no provider above it
    expect(wrapper.find('.das-pending-banner').exists()).toBe(false)
  })

  it('saving metadata refreshes the submission and starts nothing', async () => {
    // Editing the statement withdraws its confirmation server-side, so the
    // header re-reads the submission rather than queueing work. Saving a form
    // is not a decision to spend an LM call.
    const wrapper = mountHeader({ das_suggestions: { status: 'pending_input' } })
    const store = useSubmissionStore()
    const fetchSubmission = vi.spyOn(store, 'fetchSubmission').mockResolvedValue(submission)

    await wrapper.vm.$.setupState.handleMetadataSaved()

    expect(fetchSubmission).toHaveBeenCalledWith('sub-1')
  })

  it('the header never queues a job of its own', () => {
    // The old handler called advanceJob on save. Pinned on the source: a header
    // that can start pipeline work makes "what started this run" unanswerable.
    const source = readFileSync(join(import.meta.dirname, 'SubmissionHeader.vue'), 'utf8')
    expect(source).not.toMatch(/advanceJob|runAllProcesses|requeue/)
  })
})

describe('every view that polls jobs and renders the header', () => {
  const viewsDir = join(import.meta.dirname, '../../views/submissions')

  it('provides submissionJobs itself, not through a child component', () => {
    const offenders = []
    for (const file of readdirSync(viewsDir).filter((f) => f.endsWith('.vue'))) {
      const source = readFileSync(join(viewsDir, file), 'utf8')
      const rendersHeader = /<SubmissionHeader[\s>]/.test(source)
      const pollsJobs = /useJobPoller|BackgroundProcesses/.test(source)
      if (!rendersHeader || !pollsJobs) continue
      if (!source.includes("provide('submissionJobs'")) offenders.push(file)
    }
    expect(offenders, 'these views leave the header blind to the pipeline').toEqual([])
  })
})
