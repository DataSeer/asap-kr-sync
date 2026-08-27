// @vitest-environment happy-dom
/**
 * A submission card is a link, and its action buttons still work.
 *
 * The card used to be a `<div @click>` whose handler called
 * `window.open(href, '_blank')`. Two things wrong with that, and they pull in
 * opposite directions: every click opened a new tab whether you wanted one or
 * not, and a MIDDLE click — the gesture that means "new tab" — did nothing at
 * all, because a div has no link behaviour to invoke. Nor did hover show a
 * destination, nor could the address be copied.
 *
 * It is now a stretched `<a>` over the whole card. The browser already knows
 * how to do all of that; none of it is worth reimplementing on a click handler.
 *
 * The risk that introduces is layering. The anchor covers the card, so it also
 * covers the edit / hide / delete buttons unless they are lifted above it — and
 * when that is wrong, nothing throws and nothing looks different. Every action
 * button on the dashboard simply navigates instead. It happened while writing
 * this: the z-index edit did not apply, the comment described a layering that
 * was not there, and hit-testing in a real browser is what caught it.
 *
 * So the second test asserts the stacking, which is the part that fails
 * silently.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useAuthStore } from '@/stores/auth.store'
import SubmissionCard from './SubmissionCard.vue'
import { tooltip } from '@/directives/tooltip'

const submission = {
  id: 'sub-1',
  title: 'A manuscript',
  status: 'step_pdf',
  currentRound: 1,
  user: { id: 'u-1', name: 'Dr Author' },
  createdAt: '2026-08-27T10:00:00Z'
}

function mountCard() {
  setActivePinia(createPinia())
  useAuthStore().user = { id: 'u-1', role: 'admin', name: 'Admin' }

  return mount(SubmissionCard, {
    props: { submission, showActions: true },
    global: {
      directives: { tooltip },
      stubs: { RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } }
    }
  })
}

describe('a submission card', () => {
  it('navigates through a real link, not a click handler', () => {
    const wrapper = mountCard()
    const link = wrapper.find('a')

    expect(link.exists()).toBe(true)
    // A route object, so the router resolves it — and so the browser gets an
    // href it can show on hover, copy, and open in a new tab on middle click.
    expect(link.attributes('href')).toBeTruthy()
  })

  it('covers the whole card, so anywhere on it is clickable', () => {
    const wrapper = mountCard()
    const link = wrapper.find('a')

    expect(link.classes()).toContain('absolute')
    expect(link.classes()).toContain('inset-0')
  })

  it('keeps the action buttons ABOVE the link', () => {
    // The failure this catches is silent: with the stacking wrong, every action
    // button navigates instead of acting, and the card looks identical.
    const wrapper = mountCard()
    const actions = wrapper.findAll('button')

    expect(actions.length).toBeGreaterThan(0)
    for (const button of actions) {
      const stack = button.element.closest('[class*="z-10"]')
      expect(stack, 'an action button sits under the stretched link').not.toBe(null)
    }
  })

  it('no longer emits a click for a parent to turn into window.open', () => {
    // The old contract. A parent still listening for it would be waiting for an
    // event that never comes, which is quieter than a crash and worse.
    const wrapper = mountCard()

    expect(Object.keys(wrapper.emitted())).not.toContain('click')
  })
})
