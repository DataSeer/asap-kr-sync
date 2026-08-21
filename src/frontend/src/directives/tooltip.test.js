// @vitest-environment happy-dom
/**
 * The tooltip that replaces the browser's native `title` across the app.
 *
 * Replacing a native feature means inheriting its contract, and the parts
 * users would notice if they were dropped:
 *   - an empty or absent value shows nothing (a native `title=""` shows
 *     nothing either — and ~a dozen call sites pass a conditional that
 *     evaluates to '');
 *   - the text follows the value when it changes;
 *   - it disappears on leave, on click, on scroll — a tooltip stranded over
 *     unrelated content is worse than the native one it replaced;
 *   - it never leaves a stray node behind when its element unmounts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { tooltip, __testing } from './tooltip'

/** Mount a button carrying the directive, with a reactive value. */
function mountTarget(initial) {
  const text = ref(initial)
  const wrapper = mount(defineComponent({
    setup() { return { text } },
    template: '<button v-tooltip="text">hover me</button>'
  }), { global: { directives: { tooltip } } })
  return { wrapper, text }
}

const layerText = () => __testing.layer?.textContent ?? null
const isShown = () => __testing.layer?.dataset.show === 'true'

describe('v-tooltip', () => {
  beforeEach(() => { vi.useFakeTimers(); __testing.reset() })
  afterEach(() => { vi.useRealTimers(); __testing.reset() })

  it('shows the text on hover, after the delay', async () => {
    const { wrapper } = mountTarget('Delete this row')
    await wrapper.find('button').trigger('mouseenter')

    expect(isShown()).toBe(false)   // not instantly — sweeping a table must not strobe
    vi.advanceTimersByTime(200)
    expect(isShown()).toBe(true)
    expect(layerText()).toBe('Delete this row')
  })

  it('shows nothing at all for an empty value', async () => {
    // Several call sites pass `cond ? 'text' : ''`.
    const { wrapper } = mountTarget('')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(200)

    expect(isShown()).toBe(false)
  })

  it('shows nothing for null or undefined', async () => {
    for (const value of [null, undefined]) {
      __testing.reset()
      const { wrapper } = mountTarget(value)
      await wrapper.find('button').trigger('mouseenter')
      vi.advanceTimersByTime(200)
      expect(isShown()).toBe(false)
    }
  })

  it('hides on mouseleave', async () => {
    const { wrapper } = mountTarget('Something')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(200)
    expect(isShown()).toBe(true)

    await wrapper.find('button').trigger('mouseleave')
    expect(isShown()).toBe(false)
  })

  it('hides on click — the click usually opens something else', async () => {
    const { wrapper } = mountTarget('Something')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(200)

    await wrapper.find('button').trigger('click')
    expect(isShown()).toBe(false)
  })

  it('does not fire if the pointer leaves before the delay elapses', async () => {
    const { wrapper } = mountTarget('Something')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(50)
    await wrapper.find('button').trigger('mouseleave')
    vi.advanceTimersByTime(500)

    expect(isShown()).toBe(false)
  })

  it('follows the value when it changes', async () => {
    const { wrapper, text } = mountTarget('before')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(200)
    expect(layerText()).toBe('before')

    text.value = 'after'
    await nextTick()
    expect(layerText()).toBe('after')
  })

  it('hides when the value becomes empty while it is showing', async () => {
    const { wrapper, text } = mountTarget('here')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(200)
    expect(isShown()).toBe(true)

    text.value = ''
    await nextTick()
    expect(isShown()).toBe(false)
  })

  it('strips a native title from the same element, so they cannot double up', async () => {
    const wrapper = mount(defineComponent({
      template: '<button v-tooltip="\'styled\'" title="native">x</button>'
    }), { global: { directives: { tooltip } } })

    expect(wrapper.find('button').attributes('title')).toBeUndefined()
  })

  it('hides when its element unmounts, leaving nothing stranded', async () => {
    const { wrapper } = mountTarget('Something')
    await wrapper.find('button').trigger('mouseenter')
    vi.advanceTimersByTime(200)
    expect(isShown()).toBe(true)

    wrapper.unmount()
    expect(isShown()).toBe(false)
  })

  it('opens immediately on keyboard focus', async () => {
    // A keyboard user has already committed to the element; the hover delay
    // exists to stop mouse sweeps, which do not apply.
    const { wrapper } = mountTarget('Keyboard reachable')
    await wrapper.find('button').trigger('focus')

    expect(isShown()).toBe(true)
  })

  it('uses a single shared node however many targets exist', async () => {
    const wrapper = mount(defineComponent({
      template: '<div><button class="a" v-tooltip="\'A\'">a</button><button class="b" v-tooltip="\'B\'">b</button></div>'
    }), { global: { directives: { tooltip } } })

    await wrapper.find('.a').trigger('mouseenter')
    vi.advanceTimersByTime(200)
    await wrapper.find('.b').trigger('mouseenter')
    vi.advanceTimersByTime(200)

    expect(document.querySelectorAll('.app-tooltip')).toHaveLength(1)
    expect(layerText()).toBe('B')
  })
})
