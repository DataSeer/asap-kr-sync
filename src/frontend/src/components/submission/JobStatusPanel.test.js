// @vitest-environment happy-dom
/**
 * The processes panel's header: what it claims about time and progress.
 *
 * The panel draws tiles from its own list of eleven modules, but computes the
 * estimate, the progress bar and the "still running" affordances from the raw
 * jobs map — which can hold a job the tiles never draw. When the DAS check
 * became a pipeline step gated to the Availability step, that is exactly what
 * happened: the tiles said "11/11 done" while the header offered "15s to 3 min
 * remaining", kept the "you can keep editing" hint up, and left Cancel
 * processing on screen, for a run that had finished.
 *
 * So these are about the header agreeing with the tiles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The panel reaches for these on mount. Stubbed so the test asserts on the
// panel's own logic rather than on whatever a dev server happens to answer.
vi.mock('@/services/job.service', () => ({ default: { getJobs: vi.fn().mockResolvedValue({ jobs: [] }) } }))
vi.mock('@/services/config.service', () => ({
  default: {
    getServiceStatus: vi.fn().mockResolvedValue({ services: {} }),
    getPipeline: vi.fn().mockResolvedValue({ nodes: [], stageCount: 0 })
  }
}))
vi.mock('@/services/file.service', () => ({ default: { download: vi.fn() } }))
// The resource-type store fetches its list on first use (it drives the tables'
// ordering); the panel touches it just by existing.
vi.mock('@/services/resourceTypes.service', () => ({
  default: {
    list: vi.fn().mockResolvedValue({ resourceTypes: [] }),
    getAll: vi.fn().mockResolvedValue({ resourceTypes: [] }),
    getNames: vi.fn().mockResolvedValue([])
  }
}))
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { h, ref } from 'vue'
import JobStatusPanel from './JobStatusPanel.vue'

// A fresh Pinia per test. At module scope it leaks between files — the panel
// reads the resource-type store on mount, and picked up a store created under
// a different instance, which is not the same object.
beforeEach(() => setActivePinia(createPinia()))

const stub = { render: () => h('div') }
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: stub },
    { path: '/submissions/:id/pipeline', name: 'submission-pipeline', component: stub },
    { path: '/submissions/:id/pipeline/:type', name: 'submission-module', component: stub }
  ]
})

/** The eleven modules the panel draws, all finished. */
const FINISHED = [
  'markdown_convert', 'orcid_extraction', 'das_extraction',
  'software_detection', 'datasets_detection', 'materials_detection',
  'protocols_detection', 'identifier_detection',
  'krt_grounding', 'pdf_analysis', 'suggestion_generation'
]

const complete = () => Object.fromEntries(
  FINISHED.map((jobType) => [jobType, { type: jobType, jobType, status: 'complete', result: {} }])
)

function mountPanel(jobs) {
  return mount(JobStatusPanel, {
    global: {
      plugins: [router],
      provide: { submissionJobs: ref(jobs) },
      stubs: { RouterLink: { template: '<a><slot /></a>' } }
    }
  })
}

describe('when every drawn module has finished', () => {
  it('says so, and offers no remaining time', async () => {
    const wrapper = mountPanel(complete())
    await router.isReady()

    expect(wrapper.text()).toContain('Pipeline complete')
    expect(wrapper.text()).not.toMatch(/remaining/i)
  })

  it('still says so when a step is parked behind a LATER submission step', async () => {
    // The regression. The DAS check waits for the Availability step, so on the
    // PDF step it is `waiting` for ever — and the panel does not draw it.
    const wrapper = mountPanel({
      ...complete(),
      das_suggestions: {
        type: 'das_suggestions',
        jobType: 'das_suggestions',
        status: 'waiting',
        waitingReason: 'availability_step'
      }
    })
    await router.isReady()

    expect(wrapper.text(), 'a job the panel does not draw must not drive its estimate')
      .toContain('Pipeline complete')
    expect(wrapper.text()).not.toMatch(/remaining/i)
    expect(wrapper.text()).not.toMatch(/keep editing/i)
  })

  it('does not offer to cancel a run that has finished', async () => {
    const wrapper = mountPanel({
      ...complete(),
      das_suggestions: {
        type: 'das_suggestions', jobType: 'das_suggestions',
        status: 'waiting', waitingReason: 'availability_step'
      }
    })
    await router.isReady()

    expect(wrapper.text()).not.toMatch(/cancel processing/i)
  })
})

describe('when work really is outstanding', () => {
  it('a running step still produces an estimate', async () => {
    const jobs = complete()
    jobs.pdf_analysis = { type: 'pdf_analysis', jobType: 'pdf_analysis', status: 'processing' }
    const wrapper = mountPanel(jobs)
    await router.isReady()

    expect(wrapper.text()).not.toContain('Pipeline complete')
  })

  it('a step waiting for something the user can act on NOW still counts', async () => {
    // The exemption is for a later step, not for waiting in general: a detector
    // held by the KRT gate is work the reader can release immediately.
    const jobs = complete()
    jobs.datasets_detection = {
      type: 'datasets_detection', jobType: 'datasets_detection',
      status: 'waiting', waitingReason: 'krt_validation'
    }
    const wrapper = mountPanel(jobs)
    await router.isReady()

    expect(wrapper.text()).not.toContain('Pipeline complete')
  })
})
