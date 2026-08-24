// @vitest-environment happy-dom
/**
 * The module page's account of a partly-complete run.
 *
 * This is where a finished run is actually read — the job popup never opens for
 * a completed step, because a completed tile links here instead. So if the
 * degradation is not stated on this page, the only place it appears is a badge
 * on a panel the reader has already left.
 *
 * It leads the panel rather than sitting with the counts on purpose: they
 * below it are correct but are a floor, not a total, and a reader who meets the
 * number first has already drawn the wrong conclusion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'
import { useAuthStore } from '@/stores/auth.store'

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } })
}))
vi.mock('@/services/job.service', () => ({ default: { getJobPrompts: vi.fn().mockResolvedValue({ prompts: [] }) } }))
vi.mock('@/services/file.service', () => ({ default: { download: vi.fn() } }))

import ModuleTechnical from './ModuleTechnical.vue'

const job = (outcome) => ({
  jobType: 'software_detection',
  status: 'complete',
  result: {
    status: { detected: true },
    // `total` is Softcite's raw mention count — 0 when Softcite never answered.
    // Present because the real row has it; that is the number this blanks.
    counts: { total: 0, unique: 21, enriched: 0 },
    data: { meta: { uniqueCount: 21, lmCount: 21, softciteCount: 0 } },
    service: { config: { state: 'on', enabled: true, demoEnabled: false }, outcome }
  }
})

/** The panel is a collapsed disclosure — open it, or nothing is asserted. */
async function mountOpen(outcome) {
  const wrapper = mount(ModuleTechnical, {
    props: { job: job(outcome), jobType: 'software_detection', submissionId: 'sub-1', jobs: {} },
    global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  // The panel opens on arrival now, so a click here would CLOSE it.
  if (!wrapper.find('.mt-body').exists()) {
    await wrapper.find('button.mt-toggle').trigger('click')
  }
  return wrapper
}

describe('a partly-complete run on the module page', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('says so, and names the engine that failed', async () => {
    const wrapper = await mountOpen({
      state: 'partial', source: 'external',
      failReason: 'softcite_failed', externalError: 'Softcite error: Service error'
    })

    const panel = wrapper.find('.mt-degraded')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('Partly complete')
    expect(panel.text()).toContain('softcite')
  })

  it('shows the service\'s own error text', async () => {
    const wrapper = await mountOpen({
      state: 'partial', source: 'external',
      failReason: 'softcite_failed', externalError: 'Softcite error: Service error'
    })

    expect(wrapper.find('.mt-degraded-error').text()).toBe('Softcite error: Service error')
  })

  it('says the counts are real but incomplete — not that they are wrong', async () => {
    const wrapper = await mountOpen({
      state: 'partial', source: 'external', failReason: 'softcite_failed', externalError: 'x'
    })

    const text = wrapper.find('.mt-degraded').text()
    expect(text).toMatch(/real/)
    expect(text).toMatch(/re-run/i)
  })

  it('says nothing at all on a healthy run', async () => {
    const wrapper = await mountOpen({ state: 'done', source: 'external', failReason: null, externalError: null })

    expect(wrapper.find('.mt-degraded').exists()).toBe(false)
  })

  it('says nothing on an outright failure — that is the badge\'s job, not a caveat', async () => {
    const wrapper = await mountOpen({
      state: 'fail', source: null, failReason: 'external_failed_demo_disabled', externalError: 'boom'
    })

    expect(wrapper.find('.mt-degraded').exists()).toBe(false)
  })
})

describe('counts owned by the failed engine', () => {
  it('are blanked, not shown as zero', async () => {
    // "Total 0 / Unique 18" reads as "Softcite looked and found none", which is
    // the opposite of what happened. Same error the panel summary used to make
    // with "Softcite 0 + LM 18".
    const wrapper = await mountOpen({
      state: 'partial', source: 'external', failReason: 'softcite_failed', externalError: 'x'
    })

    // The module's own counts live in their own box now, apart from the run and
    // the cost, which read the same on every module.
    const found = wrapper.find('.mt-results')
    expect(found.exists(), 'the results block must render').toBe(true)
    expect(found.text()).toContain('—')
    // "Found" is what `total` is called for a detector — see STAT_META.
    expect(found.text()).not.toMatch(/Found\s*0\b/)
  })

  it('are shown normally on a healthy run', async () => {
    const wrapper = await mountOpen({ state: 'done', source: 'external', failReason: null, externalError: null })

    // A real zero from an engine that DID answer is information, and stays.
    expect(wrapper.text()).toMatch(/Found\s*0/)
  })
})

describe('a past run whose artefacts were not kept apart', () => {
  const pastRun = (over) => ({
    ...job({ state: 'done', source: 'external' }),
    isLatest: false,
    runNumber: 1,
    runCount: 3,
    result: {
      ...job({ state: 'done', source: 'external' }).result,
      files: { 'gemini-software': 'some/key.json' }
    },
    ...over
  })

  async function mountRun(over) {
    // The outputs block is gated on canViewJobInternals, and so is the caveat
    // inside it — an author sees no outputs, so there is nothing to caveat.
    useAuthStore().user = { id: 'u1', role: 'ds_annotator', name: 'Curator' }
    const wrapper = mount(ModuleTechnical, {
      props: { job: pastRun(over), jobType: 'software_detection', submissionId: 'sub-1', jobs: {} },
      global: { directives: { tooltip }, stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    })
    if (!wrapper.find('.mt-body').exists()) {
      await wrapper.find('button.mt-toggle').trigger('click')
    }
    return wrapper
  }

  it('says why its outputs are missing, rather than showing a later run\'s', async () => {
    const wrapper = await mountRun({ artefactsAreOwn: false })

    expect(wrapper.find('.mt-note-warn').exists()).toBe(true)
    expect(wrapper.find('.mt-note-warn').text()).toMatch(/not kept separately/)
    expect(wrapper.text()).not.toContain('gemini-software ↗')
  })

  it('shows them when the run does own them', async () => {
    const wrapper = await mountRun({ artefactsAreOwn: true })

    expect(wrapper.find('.mt-note-warn').exists()).toBe(false)
  })

  it('never suppresses the latest run\'s outputs — it wrote last', async () => {
    // Whatever is in a shared folder IS the latest run's, so the caveat would be
    // false there.
    const wrapper = await mountRun({ isLatest: true, artefactsAreOwn: false })

    expect(wrapper.find('.mt-note-warn').exists()).toBe(false)
  })
})
