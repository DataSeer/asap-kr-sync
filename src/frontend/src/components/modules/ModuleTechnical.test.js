// @vitest-environment happy-dom
/**
 * The Technical detail block's MODULE INPUTS column.
 *
 * A module missing from the READS table renders that column empty, and an empty
 * column does not look like a bug — it looks like a module that reads nothing.
 * That is how the DAS check shipped: it reads the author's statement and their
 * KRT, and said so nowhere.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { h } from 'vue'
import ModuleTechnical from './ModuleTechnical.vue'
import { MODULE_META } from './module-meta'

vi.mock('@/services/file.service', () => ({ default: { download: vi.fn() } }))
vi.mock('@/services/config.service', () => ({
  default: { getSourceInfo: vi.fn().mockResolvedValue({ repoUrl: 'https://example.test/repo', branch: 'main' }) }
}))

const stub = { render: () => h('div') }
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: stub },
    { path: '/submissions/:id/pipeline/:type', name: 'submission-module', component: stub }
  ]
})

beforeEach(() => setActivePinia(createPinia()))

/** Open the disclosure so the columns render. */
async function mountOpen(props) {
  const wrapper = mount(ModuleTechnical, {
    props: { submissionId: 'sub-1', jobs: {}, files: {}, ...props },
    global: { plugins: [router] }
  })
  await wrapper.find('button.mt-toggle').trigger('click')
  return wrapper
}

const dasJob = (over = {}) => ({
  type: 'das_suggestions',
  status: 'complete',
  result: {
    data: { suggestions: [] },
    // This module stores its meta at result.meta, unlike the others.
    meta: { model: 'gemini-2.5-flash', dasLength: 437, krtRowCount: 38, total: 9, applicable: 5 },
    files: { inputs: 'key/inputs.json', 'das-suggestions': 'key/das.json' },
    ...over
  }
})

describe('the DAS check names what it reads', () => {
  it('lists the Availability Statement and the KRT', async () => {
    const wrapper = await mountOpen({
      jobType: 'das_suggestions',
      job: dasJob(),
      jobs: { das_extraction: { type: 'das_extraction', status: 'complete', result: { status: { detected: true } } } },
      files: { krt: { id: 'krt-1' } }
    })

    const text = wrapper.text()
    expect(text).toContain('Module inputs')
    expect(text).toContain('Your Availability Statement')
    expect(text).toContain('Your Key Resources Table')
  })

  it('shows the counts describing what the run was given', async () => {
    const wrapper = await mountOpen({ jobType: 'das_suggestions', job: dasJob() })

    expect(wrapper.text()).toContain('Characters of Availability Statement')
    expect(wrapper.text()).toContain('437')
    expect(wrapper.text()).toContain('KRT rows summarised for the check')
    expect(wrapper.text()).toContain('38')
  })

  it('reads meta from result.meta as well as result.data.meta', async () => {
    // The DAS module's stored shape differs from every other module's. Reading
    // only one of them left its statistics and input counts blank.
    const viaData = await mountOpen({
      jobType: 'pdf_analysis',
      job: { type: 'pdf_analysis', status: 'complete', result: { data: { meta: { seedCount: 7 } } } }
    })
    expect(viaData.text()).toContain('Author rows used as seeds')
    expect(viaData.text()).toContain('7')

    const viaTop = await mountOpen({ jobType: 'das_suggestions', job: dasJob() })
    expect(viaTop.text()).toContain('437')
  })

  it('says the statement was entered by hand when extraction found none', async () => {
    const wrapper = await mountOpen({
      jobType: 'das_suggestions',
      job: dasJob(),
      jobs: { das_extraction: { type: 'das_extraction', status: 'complete', result: { status: { detected: false } } } }
    })

    expect(wrapper.text()).toMatch(/not found in the manuscript/i)
  })
})

describe('every module says what it reads', () => {
  it('no module renders an empty inputs column', async () => {
    // The check that would have caught the omission: a module with no entry in
    // READS shows a blank column, which reads as "this module reads nothing".
    for (const jobType of Object.keys(MODULE_META)) {
      const wrapper = await mountOpen({
        jobType,
        job: { type: jobType, status: 'complete', result: { data: { meta: {} } } },
        jobs: {
          das_extraction: { type: 'das_extraction', status: 'complete', result: { status: { detected: true } } },
          markdown_convert: { type: 'markdown_convert', status: 'complete', result: { data: { markdownLength: 100 } } },
          pdf_analysis: { type: 'pdf_analysis', status: 'complete', result: { data: { items: [] } } },
          datasets_detection: { type: 'datasets_detection', status: 'complete', result: { data: { items: [] } } }
        },
        files: { krt: { id: 'krt-1' }, pdf: { id: 'pdf-1' } }
      })

      expect(wrapper.text(), `${jobType} names none of its inputs`).toContain('Module inputs')
    }
  })
})
