// @vitest-environment happy-dom
/**
 * A run that produced real rows with one of its engines dead.
 *
 * Software detection unions Softcite (a NER service on the PDF) with an LM pass
 * (over the markdown). Either can now fail without taking the module down — so
 * a completed job can hold a genuine, INCOMPLETE answer.
 *
 * The badge is the whole point. Green "Done" over a short software table is the
 * same mistake as nine green ticks over a statement nobody read: the number
 * looks like the total. Amber "Partial", with the reason attached, is the
 * difference between a result and a claim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip, __testing } from '@/directives/tooltip'

// The panel links out to the pipeline page, so it needs a route to read an id
// from. Partial mock — the real module is still imported by @/router, which the
// stores pull in.
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } })
}))
vi.mock('@/services/job.service', () => ({ default: { getJobs: vi.fn().mockResolvedValue({ jobs: [] }) } }))
vi.mock('@/services/config.service', () => ({
  default: { getPipeline: vi.fn().mockResolvedValue({ nodes: [] }), getServiceStatus: vi.fn().mockResolvedValue({ services: {} }) }
}))
vi.mock('@/services/file.service', () => ({ default: { getFiles: vi.fn().mockResolvedValue([]) } }))

import JobStatusPanel from './JobStatusPanel.vue'

/** A completed software_detection job carrying the given outcome. */
const softwareJob = (outcome, items = 21) => ({
  jobType: 'software_detection',
  status: 'complete',
  result: {
    status: { detected: true },
    // `counts.unique` is what the panel's summary reads; `meta` is what the
    // engine breakdown reads. Both, or the fixture tests a shape the app
    // never produces.
    counts: { unique: items, enriched: 0 },
    data: { meta: { uniqueCount: items, lmCount: items, softciteCount: 0, softciteFailed: outcome.state === 'partial' } },
    service: { config: { state: 'on', enabled: true, demoEnabled: false }, outcome }
  }
})

function mountPanel(job) {
  return mount(JobStatusPanel, {
    global: {
      directives: { tooltip },
      provide: { submissionJobs: ref({ software_detection: job }) },
      stubs: { RouterLink: { template: '<a><slot /></a>' }, Teleport: true }
    }
  })
}

describe('a partial outcome', () => {
  beforeEach(() => { setActivePinia(createPinia()); __testing.reset(); vi.clearAllMocks() })

  it('is labelled Partial, not Done', () => {
    const wrapper = mountPanel(softwareJob({
      state: 'partial', source: 'external',
      failReason: 'softcite_failed', externalError: 'Softcite error: Service error'
    }))

    const text = wrapper.text()
    expect(text).toContain('Partial')
    expect(text).not.toMatch(/\bDone\b/)
  })

  it('is amber, not green — a short table must not look complete', () => {
    const wrapper = mountPanel(softwareJob({
      state: 'partial', source: 'external', failReason: 'softcite_failed', externalError: 'x'
    }))

    // Scoped to the badge itself: the panel legitimately uses the green class
    // elsewhere (the overall progress summary), so a page-wide assertion would
    // be testing the wrong thing.
    const badge = wrapper.find('.job-status-badge.job-status-partial')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).not.toContain('job-status-complete')
  })

  it('says which engine went missing, in words', () => {
    const wrapper = mountPanel(softwareJob({
      state: 'partial', source: 'external', failReason: 'softcite_failed', externalError: 'Service error'
    }))

    expect(wrapper.text()).toContain('Softcite was unavailable')
  })

  it('still shows the rows that were found — they are real', () => {
    const wrapper = mountPanel(softwareJob({
      state: 'partial', source: 'external', failReason: 'softcite_failed', externalError: 'Service error'
    }, 21))

    expect(wrapper.text()).toMatch(/21 unique mention/)
    expect(wrapper.text()).toContain('LM pass only (Softcite failed)')
    expect(wrapper.text()).not.toContain('Softcite 0')   // would read as "looked, found none"
  })

  it('carries the detail in a custom tooltip, never a native title', async () => {
    const wrapper = mountPanel(softwareJob({
      state: 'partial', source: 'external',
      failReason: 'softcite_failed', externalError: 'Softcite error: Service error'
    }))

    const badge = wrapper.find('.job-status-partial')
    expect(badge.attributes('title')).toBeUndefined()

    badge.element.dispatchEvent(new Event('focus'))
    await nextTick()
    expect(__testing.layer?.dataset.show).toBe('true')
    expect(__testing.layer.textContent).toContain('Softcite was unavailable')
    expect(__testing.layer.textContent).toContain('Service error')
  })

  it('leaves a healthy run green and untouched', () => {
    const wrapper = mountPanel(softwareJob({ state: 'done', source: 'external', failReason: null, externalError: null }))

    expect(wrapper.find('.job-status-partial').exists()).toBe(false)
    expect(wrapper.text()).toContain('Done')
  })

  it('leaves a true failure red', () => {
    const wrapper = mountPanel(softwareJob({
      state: 'fail', source: null, failReason: 'external_failed_demo_disabled', externalError: 'boom'
    }))

    expect(wrapper.find('.job-status-partial').exists()).toBe(false)
    expect(wrapper.text()).toContain('Fail')
  })
})
