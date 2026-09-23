// @vitest-environment happy-dom
/**
 * Logging out in one tab must reach the others, and nothing else must.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { announceLogout, onLogout, _resetForTests } from './session-broadcast'

/** A minimal BroadcastChannel that delivers to every OTHER open instance. */
function installFakeChannel() {
  const open = new Set()
  class FakeChannel {
    constructor(name) {
      this.name = name
      this.listeners = new Set()
      open.add(this)
    }
    postMessage(data) {
      for (const other of open) {
        // The real API never delivers to the sender.
        if (other !== this && other.name === this.name) {
          other.listeners.forEach(fn => fn({ data }))
        }
      }
    }
    addEventListener(_type, fn) { this.listeners.add(fn) }
    removeEventListener(_type, fn) { this.listeners.delete(fn) }
    close() { open.delete(this) }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  return { open, FakeChannel }
}

describe('session-broadcast', () => {
  beforeEach(() => _resetForTests())
  afterEach(() => { _resetForTests(); vi.unstubAllGlobals() })

  it('delivers a logout to another tab', () => {
    const { FakeChannel } = installFakeChannel()
    const other = new FakeChannel('asap-kr-session')
    const heard = vi.fn()
    other.addEventListener('message', heard)

    announceLogout()

    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard.mock.calls[0][0].data).toEqual({ type: 'logout' })
  })

  it('never fires the handler in the tab that logged out', () => {
    installFakeChannel()
    const handler = vi.fn()
    onLogout(handler)
    announceLogout()
    expect(handler).not.toHaveBeenCalled()
  })

  it('ignores a message that is not a logout', () => {
    const { FakeChannel } = installFakeChannel()
    const handler = vi.fn()
    onLogout(handler)
    new FakeChannel('asap-kr-session').postMessage({ type: 'something-else' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops listening once unsubscribed', () => {
    const { FakeChannel } = installFakeChannel()
    const handler = vi.fn()
    const stop = onLogout(handler)
    const other = new FakeChannel('asap-kr-session')

    other.postMessage({ type: 'logout' })
    expect(handler).toHaveBeenCalledTimes(1)

    stop()
    other.postMessage({ type: 'logout' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('degrades quietly where BroadcastChannel does not exist', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    expect(() => announceLogout()).not.toThrow()
    const stop = onLogout(() => { throw new Error('must not run') })
    expect(() => stop()).not.toThrow()
  })
})
