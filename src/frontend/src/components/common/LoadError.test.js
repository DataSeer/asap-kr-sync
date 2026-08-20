// @vitest-environment happy-dom
/**
 * The page-level "this did not load" panel.
 *
 * It exists because of what these views did instead: let the submission fetch
 * reject, abort the rest of the mount chain, and render the empty state as
 * though it were the answer — "No PDF file is associated with this submission",
 * a green "Submission Complete!", an availability check reporting a clean
 * statement. A 403 or a 500 then reads as a fact about the manuscript.
 *
 * So the two things that matter here are that it says the page never received
 * the data, and that it only offers a retry when retrying could help.
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LoadError from './LoadError.vue'

const mountError = (props = {}) => mount(LoadError, { props })

describe('LoadError', () => {
  it('says nothing on the page is a reading of the submission', () => {
    const wrapper = mountError({ message: 'Internal server error' })

    expect(wrapper.text()).toContain('never received it')
  })

  it('shows the server\'s message when there is one', () => {
    const wrapper = mountError({ message: 'Internal server error' })

    expect(wrapper.text()).toContain('Internal server error')
  })

  it('offers a retry for a failure that retrying could fix', async () => {
    const wrapper = mountError({ message: 'The server did not respond.' })

    const button = wrapper.find('button')
    expect(button.exists()).toBe(true)

    await button.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('offers no retry when retrying cannot help', () => {
    // A 403 is not a transient condition. A "Try again" button that will always
    // fail teaches the user to ignore the panel.
    const wrapper = mountError({ message: 'You do not have access.', retryable: false })

    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('still states the failure when the server sent no message', () => {
    const wrapper = mountError()

    expect(wrapper.text()).toContain('could not be loaded')
  })
})
