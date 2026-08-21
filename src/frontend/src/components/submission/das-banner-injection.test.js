// @vitest-environment happy-dom
/**
 * The DAS banner is the only way a user learns that pdf_analysis is parked
 * waiting for an Availability Statement, and saving the statement is what
 * releases it. Both hang off ONE injection — `submissionJobs`.
 *
 * The regression this guards: `provide('submissionJobs', jobs)` was moved out
 * of the view and into BackgroundProcesses, which is SubmissionHeader's
 * SIBLING. provide() only travels down, so the header silently fell back to
 * its `ref({})` default: no banner, and saving a DAS advanced nothing. Nothing
 * threw, nothing logged — the pipeline just sat there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/services/job.service', () => ({
  default: { advanceJob: vi.fn().mockResolvedValue({}) }
}))
vi.mock('@/services/file.service', () => ({ default: { getFiles: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/krt.service', () => ({ default: { getKRT: vi.fn().mockResolvedValue({}) } }))

import jobService from '@/services/job.service'
import SubmissionHeader from './SubmissionHeader.vue'

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

describe('the DAS pending-input banner', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('shows when the injected job is pending_input', () => {
    const wrapper = mountHeader({ pdf_analysis: { status: 'pending_input' } })
    expect(wrapper.find('.das-pending-banner').exists()).toBe(true)
  })

  it('stays hidden while the job is running normally', () => {
    const wrapper = mountHeader({ pdf_analysis: { status: 'processing' } })
    expect(wrapper.find('.das-pending-banner').exists()).toBe(false)
  })

  it('releases the parked step when a DAS is saved', async () => {
    const wrapper = mountHeader({ pdf_analysis: { status: 'pending_input' } })
    await wrapper.vm.$.setupState.handleMetadataSaved(submission, { dasChanged: true, das: 'Data are available.' })
    expect(jobService.advanceJob).toHaveBeenCalledWith('sub-1', 'pdf_analysis')
  })

  it('does not advance when the statement was not the thing that changed', async () => {
    const wrapper = mountHeader({ pdf_analysis: { status: 'pending_input' } })
    await wrapper.vm.$.setupState.handleMetadataSaved(submission, { dasChanged: false, das: 'x' })
    expect(jobService.advanceJob).not.toHaveBeenCalled()
  })

  it('cannot advance without the injection — the failure the sibling-provide caused', async () => {
    const wrapper = mountHeader(null)   // header mounted with no provider above it
    await wrapper.vm.$.setupState.handleMetadataSaved(submission, { dasChanged: true, das: 'Data are available.' })
    expect(wrapper.find('.das-pending-banner').exists()).toBe(false)
    expect(jobService.advanceJob).not.toHaveBeenCalled()
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
    expect(offenders, 'these views leave the header blind to pdf_analysis').toEqual([])
  })
})
