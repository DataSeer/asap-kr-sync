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
import api, { isReplayable, describeValidationError } from './api'
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

// ─────────────────────────────────────────────────────────────────────────────
// Validation errors must say WHAT was wrong
// ─────────────────────────────────────────────────────────────────────────────

describe('describeValidationError', () => {
  /** Exactly what the API returned when an admin tried to create a user. */
  const apiError = (details) => ({
    response: { status: 400, data: { error: 'Validation failed', code: 'VALIDATION_ERROR', details } }
  })

  it('names the field and the reason, without Joi repeating the field in quotes', () => {
    const e = apiError([{ field: 'password', message: '"password" length must be at least 8 characters long' }])
    describeValidationError(e)
    expect(e.response.data.error).toBe('Validation failed — password: length must be at least 8 characters long')
  })

  it('keeps a message that was already written for a human', () => {
    const e = apiError([{ field: 'password', message: 'Password must contain at least one letter and one number' }])
    describeValidationError(e)
    expect(e.response.data.error)
      .toBe('Validation failed — password: Password must contain at least one letter and one number')
  })

  it('joins several fields', () => {
    const e = apiError([
      { field: 'name', message: '"name" length must be at least 2 characters long' },
      { field: 'role', message: '"role" must be one of [author, asap_pm, ds_annotator, admin]' }
    ])
    describeValidationError(e)
    expect(e.response.data.error).toBe(
      'Validation failed — name: length must be at least 2 characters long; '
      + 'role: must be one of [author, asap_pm, ds_annotator, admin]'
    )
  })

  it('leaves the details array alone for components that render it themselves', () => {
    const details = [{ field: 'email', message: 'must be a valid email' }]
    const e = apiError(details)
    describeValidationError(e)
    expect(e.response.data.details).toEqual(details)
  })

  it('never appends twice, however often it is called', () => {
    const e = apiError([{ field: 'email', message: 'must be a valid email' }])
    describeValidationError(e)
    const once = e.response.data.error
    describeValidationError(e)
    expect(e.response.data.error).toBe(once)
  })

  it('leaves errors that carry no details untouched', () => {
    for (const data of [{ error: 'Email already registered' }, { error: 'Nope', details: [] }, null]) {
      const e = { response: { status: 409, data } }
      describeValidationError(e)
      expect(e.response.data?.error).toBe(data?.error)
    }
    expect(() => describeValidationError(undefined)).not.toThrow()
    expect(() => describeValidationError({})).not.toThrow()
  })
})
