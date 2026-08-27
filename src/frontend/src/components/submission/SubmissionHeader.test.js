// @vitest-environment happy-dom
/**
 * The submission header's identity strip.
 *
 * It carries the only route to the pipeline from most of the app: the module
 * statuses live on the PDF step and the pipeline page, and this header is on
 * every submission page — so if the link is absent or points at the wrong
 * submission, the pipeline becomes unreachable from four of the five steps
 * without anything appearing broken.
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { h } from 'vue'
import SubmissionHeader from './SubmissionHeader.vue'

setActivePinia(createPinia())

const stub = { render: () => h('div') }
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: stub },
    { path: '/submissions/:id/pipeline', name: 'submission-pipeline', component: stub }
  ]
})

const submission = (over = {}) => ({
  id: 'sub-42',
  title: 'A manuscript about parkin',
  manuscriptId: 'CS1-000301-020-ORG-G-1',
  currentRound: 1,
  status: 'step_pdf',
  ...over
})

const mountHeader = (props = {}) => mount(SubmissionHeader, {
  props: { submission: submission(), latestFiles: {}, ...props },
  global: { plugins: [router] }
})

const pipelineLink = (wrapper) =>
  wrapper.findAll('a').find((a) => a.text().includes('Pipeline'))

describe('the pipeline link', () => {
  it('is present, and points at THIS submission', () => {
    const link = pipelineLink(mountHeader())
    expect(link, 'the header must offer a way to the pipeline').toBeTruthy()
    expect(link.attributes('href')).toBe('/submissions/sub-42/pipeline')
  })

  it('follows the submission it is given', () => {
    const link = pipelineLink(mountHeader({ submission: submission({ id: 'another-one' }) }))
    expect(link.attributes('href')).toBe('/submissions/another-one/pipeline')
  })

  it('is a real link, so it opens in a tab like any other', () => {
    // Middle-click and ctrl-click are how a curator keeps the pipeline beside
    // the step they are working on; a click handler would break both.
    const link = pipelineLink(mountHeader())
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('href')).toBeTruthy()
  })
})

describe('the identity strip', () => {
  it('shows the title and the manuscript id', () => {
    const wrapper = mountHeader()
    expect(wrapper.text()).toContain('A manuscript about parkin')
    expect(wrapper.text()).toContain('CS1-000301-020-ORG-G-1')
  })

  it('renders nothing rather than throwing when there is no submission yet', () => {
    // The header mounts before the fetch resolves on every page.
    const wrapper = mountHeader({ submission: null })
    expect(wrapper.text()).not.toContain('Pipeline')
  })

  it('offers a prompt instead of a blank when the manuscript id is missing', () => {
    const wrapper = mountHeader({ submission: submission({ manuscriptId: null }) })
    expect(wrapper.text()).toContain('Manuscript ID not specified')
  })
})
