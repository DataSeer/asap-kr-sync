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
import { tooltip } from '@/directives/tooltip'
import { h } from 'vue'
import ModuleTechnical from './ModuleTechnical.vue'
import { MODULE_META } from './module-meta'

vi.mock('@/services/file.service', () => ({ default: { download: vi.fn() } }))
vi.mock('@/services/job.service', () => ({
  default: { getJobPrompts: vi.fn() }
}))
import jobService from '@/services/job.service'

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
    global: { plugins: [router], directives: { tooltip } }
  })
  // The panel opens on arrival now, so a click here would CLOSE it. Only click
  // when something has left it shut.
  if (!wrapper.find('.mt-body').exists()) {
    await wrapper.find('button.mt-toggle').trigger('click')
  }
  return wrapper
}

const dasJob = (over = {}) => ({
  type: 'das_suggestions',
  status: 'complete',
  result: {
    // `data.meta`, like every module. This one used to store it beside `data`,
    // and its statistics and input counts rendered blank as a result.
    data: {
      suggestions: [],
      meta: { model: 'gemini-2.5-flash', dasLength: 437, krtRowCount: 38, total: 9, applicable: 5 }
    },
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

  it('reads meta from the one place every module stores it', async () => {
    // There is a single path on purpose. A reader tolerant of two shapes lets
    // the next module drift, and the drift is invisible — a blank column, not
    // an error.
    const wrapper = await mountOpen({
      jobType: 'pdf_analysis',
      job: { type: 'pdf_analysis', status: 'complete', result: { data: { meta: { seedCount: 7 } } } }
    })
    expect(wrapper.text()).toContain('Author rows used as seeds')
    expect(wrapper.text()).toContain('7')
  })

  it('ignores a meta stored in the wrong place, rather than papering over it', async () => {
    const wrong = await mountOpen({
      jobType: 'das_suggestions',
      job: { type: 'das_suggestions', status: 'complete', result: { meta: { dasLength: 437 } } }
    })
    expect(wrong.text()).not.toContain('437')
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

// ── The prompt a run used ───────────────────────────────────────────────────
//
// This used to be a GitHub link, built from the recorded path and the branch
// the deployment tracks. It was quietly wrong: the running app is not always at
// the head of its branch, and prompt files get edited, renamed and deleted — so
// a reader could be shown a prompt that was not the one that ran, with nothing
// to indicate the difference. The run freezes its own copy; the panel shows
// that copy and nothing else.

describe('the prompt shown is the run\'s own copy', () => {
  const withPrompts = (prompts) => {
    jobService.getJobPrompts.mockResolvedValue({ prompts })
  }

  it('never links to GitHub', async () => {
    withPrompts([{ key: 'prompt', file: 'src/backend/data/prompts/das-suggestions.txt', text: 'PROMPT BODY', bytes: 11 }])
    const wrapper = await mountOpen({ jobType: 'das_suggestions', job: dasJob() })
    await new Promise((r) => setTimeout(r, 0))

    expect(wrapper.html()).not.toContain('github')
    expect(wrapper.findAll('a').every((a) => !(a.attributes('href') || '').includes('/blob/'))).toBe(true)
  })

  it('opens the stored text in a tab of its own', async () => {
    // A prompt is a page of text. Read inside a panel inside a page it was a
    // keyhole, and it pushed everything below it far off screen. The tab is
    // served a blob built from the run's copy — there is no URL to link to,
    // and linking to the file in the repository is the one thing this must not
    // do, since that file is today's.
    const opened = []
    const createObjectURL = vi.fn(() => 'blob:stored-prompt')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    vi.stubGlobal('open', (url, target) => { opened.push({ url, target }); return null })

    withPrompts([{ key: 'prompt', file: 'src/backend/data/prompts/das-suggestions.txt', text: 'THE EXACT PROMPT THAT RAN', bytes: 25 }])
    const wrapper = await mountOpen({ jobType: 'das_suggestions', job: dasJob() })
    await new Promise((r) => setTimeout(r, 0))

    await wrapper.findAll('button.mt-linkish').find((b) => b.text().includes('das-suggestions.txt')).trigger('click')

    expect(opened).toEqual([{ url: 'blob:stored-prompt', target: '_blank' }])
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toMatch(/text\/plain/)
    expect(await blob.text()).toBe('THE EXACT PROMPT THAT RAN')

    vi.unstubAllGlobals()
  })

  it('lists an attachment the prompt cannot work without, openable too', async () => {
    // LangExtract's few-shot examples are handed to the extractor as a separate
    // argument and never enter the prompt text, so offering the template alone
    // would offer only part of what the run was given.
    withPrompts([{
      key: 'signalsPrompt',
      file: 'src/backend/data/prompts/blind/datasets-signals-extraction.txt',
      text: 'SIGNALS PROMPT',
      bytes: 14,
      attachments: [{ file: 'src/backend/data/prompts/datasets-signals-examples.json', text: '[{"text":"EXAMPLE ROW"}]', bytes: 24 }]
    }])
    const wrapper = await mountOpen({ jobType: 'datasets_detection', job: dasJob() })
    await new Promise((r) => setTimeout(r, 0))

    const openers = wrapper.findAll('button.mt-linkish').map((b) => b.text())
    expect(openers.some((t) => t.includes('datasets-signals-extraction.txt'))).toBe(true)
    expect(openers.some((t) => t.includes('datasets-signals-examples.json'))).toBe(true)
  })

  it('says so when a run recorded no prompt, rather than showing nothing', async () => {
    withPrompts([])
    const wrapper = await mountOpen({ jobType: 'das_suggestions', job: dasJob() })
    await new Promise((r) => setTimeout(r, 0))

    expect(wrapper.text()).toContain('recorded no prompt')
  })

  it('reports a failure to read them instead of an empty list', async () => {
    jobService.getJobPrompts.mockRejectedValue(new Error('403'))
    const wrapper = await mountOpen({ jobType: 'das_suggestions', job: dasJob() })
    await new Promise((r) => setTimeout(r, 0))

    expect(wrapper.text()).toContain('could not be read')
  })
})

describe('the panel itself', () => {
  it('is open on arrival', async () => {
    // It used to start collapsed, which made the run's own record — who ran it,
    // what it read, what it spent — something you had to know was there. On a
    // page whose subject IS one run, evidence behind a disclosure gets read by
    // nobody.
    const wrapper = mount(ModuleTechnical, {
      props: { job: dasJob(), jobType: 'das_suggestions', submissionId: 'sub-1', jobs: {}, files: {} },
      global: { plugins: [router], directives: { tooltip } }
    })

    expect(wrapper.find('.mt-body').exists()).toBe(true)
  })

  it('still closes when asked', async () => {
    const wrapper = mount(ModuleTechnical, {
      props: { job: dasJob(), jobType: 'das_suggestions', submissionId: 'sub-1', jobs: {}, files: {} },
      global: { plugins: [router], directives: { tooltip } }
    })

    await wrapper.find('button.mt-toggle').trigger('click')

    expect(wrapper.find('.mt-body').exists()).toBe(false)
  })
})

describe('a finding handed over by another module', () => {
  it('links to the module that produced it', async () => {
    // Its own record — its run, its inputs, its artefacts — rather than a dead
    // label. Documents are a different case and stay unlinked to today's
    // version: this is navigation between records, not a claim about content.
    const wrapper = await mountOpen({
      jobType: 'pdf_analysis',
      job: dasJob(),
      jobs: {
        software_detection: { type: 'software_detection', status: 'complete', result: { data: { items: [1, 2, 3] } } }
      }
    })

    const link = wrapper.findAll('a').find((a) => a.text().includes('Software Detection findings'))
    expect(link, 'the finding must be a link').toBeTruthy()
    expect(link.attributes('href')).toContain('/pipeline/software_detection')
  })

  it('still says the exact copy is in the inputs artefact', async () => {
    // The link goes to that module's latest record, which is not necessarily
    // the copy this run read. The note is what keeps that honest.
    const wrapper = await mountOpen({
      jobType: 'pdf_analysis',
      job: dasJob(),
      jobs: {
        software_detection: { type: 'software_detection', status: 'complete', result: { data: { items: [1] } } }
      }
    })

    expect(wrapper.text()).toContain('as handed to this run')
  })
})
