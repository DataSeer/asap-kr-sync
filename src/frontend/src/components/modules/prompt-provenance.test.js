// @vitest-environment happy-dom
/**
 * A stored prompt is a COPY, and the panel has to say so.
 *
 * The text shown is this run's copy, frozen when the run started. The path is
 * where that file lives in the repository — today. Printed together as
 * "src/backend/data/prompts/das-suggestions.txt · 3874 bytes" it read as though
 * the panel were showing you the file, so a prompt edited since the run looked
 * like the prompt the run had used.
 *
 * Prompts get edited about as often as old results get re-read, which is what
 * makes the confusion worth a sentence rather than a footnote somewhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

// The panel fetches the run's OWN copies when it opens — asking without the
// run number answers for the latest, which is the bug that put run 3's prompt
// beside run 1's results.
const getJobPrompts = vi.fn()
vi.mock('@/services/job.service', () => ({
  default: {
    getJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    getJobPrompts: (...a) => getJobPrompts(...a)
  }
}))

import ModuleTechnical from './ModuleTechnical.vue'

const PROMPT = {
  key: 'das_suggestions',
  file: 'src/backend/data/prompts/das-suggestions.txt',
  bytes: 3874,
  text: 'You are checking an availability statement…'
}

/** Open the panel, then the prompt inside it, and return the provenance line. */
async function provenanceLine({ startedAt = '2026-08-21T21:21:00Z' } = {}) {
  getJobPrompts.mockResolvedValue({ prompts: [PROMPT] })
  const wrapper = mount(ModuleTechnical, {
    props: {
      job: { jobType: 'das_suggestions', status: 'complete', startedAt, result: {} },
      submissionId: 'sub-1',
      jobType: 'das_suggestions'
    },
    global: { directives: { tooltip }, stubs: { RouterLink: true } }
  })
  // The panel opens on arrival now, so a click here would CLOSE it.
  if (!wrapper.find('.mt-body').exists()) {
    await wrapper.find('.mt-caret').trigger('click')
  }
  await flushPromises()
  const toggle = wrapper.findAll('button').find((b) => b.text().includes('das-suggestions.txt'))
  expect(toggle, 'the prompt must be listed before it can be opened').toBeTruthy()
  await toggle.trigger('click')
  return wrapper.find('.mt-prompt-path').text()
}

describe('the line under a stored prompt', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('calls it a copy, not the file', async () => {
    const line = await provenanceLine()

    expect(line).toMatch(/^Copy of/)
    expect(line).toContain('src/backend/data/prompts/das-suggestions.txt')
  })

  it('dates the copy to the run, not to now', async () => {
    // "as it was" with no date would be a claim with no referent.
    const line = await provenanceLine()

    expect(line).toMatch(/as it was on .*2026/)
  })

  it('warns that the file has moved on since', async () => {
    const line = await provenanceLine()

    expect(line).toMatch(/may have changed/i)
  })

  it('keeps the size, which is what identifies the copy', async () => {
    const line = await provenanceLine()

    expect(line).toContain('3874 bytes')
  })

  it('drops the date rather than inventing one when the run has no start time', async () => {
    // Older rows predate the column. "as it was on undefined" would be worse
    // than saying nothing about when.
    const line = await provenanceLine({ startedAt: null })

    expect(line).not.toMatch(/undefined|Invalid|NaN/)
    expect(line).toMatch(/may have changed/i)
  })
})
