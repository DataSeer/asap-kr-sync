// @vitest-environment happy-dom
/**
 * What the api client does when a request fails for session reasons: refresh
 * and replay on a 401, retry a request that never reached the server, and
 * go to the login page only when the refresh itself is refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }))
vi.mock('@/router', () => ({ default: { push: routerPush, currentRoute: { value: { fullPath: '/submissions/x/pdf' } } } }))
vi.mock('@/services/auth.service', () => ({ default: { refreshToken: vi.fn() } }))

import authService from '@/services/auth.service'
import api, { isReplayable } from './api'
import { reconnecting, _resetForTests } from './session-reconnect'
import { useAuthStore } from '@/stores/auth.store'

/** An adapter that answers from a scripted list of outcomes. */
function script(outcomes) {
  const seen = []
  api.defaults.adapter = async (config) => {
    seen.push(config)
    const next = outcomes.shift()
    if (next === 'network') {
      const err = new Error('Network Error'); err.code = 'ERR_NETWORK'; err.config = config; throw err
    }
    if (typeof next === 'number' && next >= 400) {
      const err = new Error('HTTP ' + next); err.config = config; err.response = { status: next, data: {}, config }; throw err
    }
    return { status: 200, data: next ?? { ok: true }, headers: {}, config }
  }
  return seen
}

describe('api client session handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    _resetForTests()
    vi.useFakeTimers()
    authService.refreshToken.mockReset()
    routerPush.mockReset()
    useAuthStore().user = { id: 'u1', role: 'author' }
  })
  afterEach(() => vi.useRealTimers())

  it('refreshes once and replays every request that hit the 401', async () => {
    authService.refreshToken.mockResolvedValue({})
    const seen = script([401, 401, { a: 1 }, { b: 2 }])
    const [a, b] = await Promise.all([api.get('/one'), api.get('/two')])
    expect(authService.refreshToken).toHaveBeenCalledTimes(1)
    expect(a.data).toEqual({ a: 1 })
    expect(b.data).toEqual({ b: 2 })
    expect(seen.map(c => c.url)).toEqual(['/one', '/two', '/one', '/two'])
    expect(useAuthStore().user).not.toBeNull()
  })

  it('sends the user to login only when the refresh is refused', async () => {
    authService.refreshToken.mockRejectedValue({ response: { status: 401 } })
    script([401])
    await expect(api.get('/one')).rejects.toBeTruthy()
    expect(useAuthStore().user).toBeNull()
    expect(routerPush).toHaveBeenCalledWith({ name: 'login', query: { redirect: '/submissions/x/pdf' } })
  })

  it('keeps the user signed in when the refresh failed for a transient reason', async () => {
    authService.refreshToken.mockRejectedValue({ code: 'ERR_NETWORK', message: 'Network Error' })
    script([401])
    const outcome = api.get('/one').catch(e => e)
    await vi.advanceTimersByTimeAsync(60000)
    await outcome
    expect(useAuthStore().user).not.toBeNull()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('retries a request that never reached the server, saying so meanwhile', async () => {
    const seen = script(['network', 'network', { saved: true }])
    const pending = api.patch('/submissions/x/krt/batch', { updates: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(reconnecting.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1000 + 3000)
    const response = await pending
    expect(response.data).toEqual({ saved: true })
    expect(seen.length).toBe(3)
    expect(reconnecting.value).toBe(false)
  })

  it('never replays an upload or an auth call', () => {
    expect(isReplayable({ url: '/submissions/x/krt/upload', data: new FormData() })).toBe(false)
    expect(isReplayable({ url: '/auth/refresh', data: {} })).toBe(false)
    expect(isReplayable({ url: '/submissions/x/krt/batch', data: { updates: [] } })).toBe(true)
  })
})
