// @vitest-environment happy-dom
/**
 * The session refresh must be one per browser, patient with blips, and firm
 * only on a real refusal (see session-reconnect.js for why).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/services/auth.service', () => ({ default: { refreshToken: vi.fn() } }))

import authService from '@/services/auth.service'
import { refreshSession, reconnecting, isDefinitiveRefusal, _resetForTests } from './session-reconnect'

const httpError = (status) => ({ response: { status } })
// happy-dom exposes navigator.locks as a getter-only property; define over it.
const setLocks = (value) => Object.defineProperty(navigator, 'locks', { value, configurable: true })
const networkError = () => ({ code: 'ERR_NETWORK', message: 'Network Error' })

describe('refreshSession', () => {
  beforeEach(() => {
    _resetForTests()
    vi.useFakeTimers()
    authService.refreshToken.mockReset()
    document.cookie = 'asap_kr_csrf=before; path=/'
    setLocks(undefined)
  })
  afterEach(() => vi.useRealTimers())

  it('issues one refresh for concurrent callers', async () => {
    authService.refreshToken.mockResolvedValue({})
    await Promise.all([refreshSession(), refreshSession(), refreshSession()])
    expect(authService.refreshToken).toHaveBeenCalledTimes(1)
  })

  it('retries a transient failure with backoff and reports reconnecting meanwhile', async () => {
    authService.refreshToken
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({})
    const done = refreshSession()
    await vi.advanceTimersByTimeAsync(0)
    expect(reconnecting.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1000 + 2000)
    await done
    expect(authService.refreshToken).toHaveBeenCalledTimes(3)
    expect(reconnecting.value).toBe(false)
  })

  it('gives up immediately on a definitive refusal', async () => {
    authService.refreshToken.mockRejectedValue(httpError(401))
    await expect(refreshSession()).rejects.toEqual(httpError(401))
    expect(authService.refreshToken).toHaveBeenCalledTimes(1)
    expect(reconnecting.value).toBe(false)
  })

  it('gives up after the last retry and stops saying reconnecting', async () => {
    authService.refreshToken.mockRejectedValue(networkError())
    const attempt = refreshSession()
    const outcome = attempt.catch((e) => e)
    await vi.advanceTimersByTimeAsync(60000)
    expect(await outcome).toEqual(networkError())
    expect(authService.refreshToken).toHaveBeenCalledTimes(6)
    expect(reconnecting.value).toBe(false)
  })

  it('skips its own refresh when another tab rotated the session while it waited for the lock', async () => {
    authService.refreshToken.mockResolvedValue({})
    // A lock whose holder (the "other tab") changes the CSRF cookie before releasing.
    setLocks({
      request: async (_name, fn) => {
        document.cookie = 'asap_kr_csrf=after; path=/'
        return fn()
      }
    })
    await refreshSession()
    expect(authService.refreshToken).not.toHaveBeenCalled()
  })

  it('refreshes under the lock when nothing changed meanwhile', async () => {
    authService.refreshToken.mockResolvedValue({})
    setLocks({ request: async (_name, fn) => fn() })
    await refreshSession()
    expect(authService.refreshToken).toHaveBeenCalledTimes(1)
  })
})

describe('isDefinitiveRefusal', () => {
  it('is only a 401 or 403 from the server', () => {
    expect(isDefinitiveRefusal(httpError(401))).toBe(true)
    expect(isDefinitiveRefusal(httpError(403))).toBe(true)
    expect(isDefinitiveRefusal(httpError(503))).toBe(false)
    expect(isDefinitiveRefusal(httpError(429))).toBe(false)
    expect(isDefinitiveRefusal(networkError())).toBe(false)
  })
})
