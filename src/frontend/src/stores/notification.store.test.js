/**
 * Toast lifetime and stacking (ASAP feedback, 2026-09): errors must fade like
 * every other toast, the pile must stay short enough to never hide the
 * bottom-right action buttons, and nothing raised in one session may survive
 * into the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useNotificationStore } from './notification.store'
import { useAuthStore } from './auth.store'

vi.mock('@/services/auth.service', () => ({ default: {} }))

describe('notification store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  it('auto-dismisses an error toast by default', () => {
    const store = useNotificationStore()
    store.error('Something failed')
    expect(store.notifications).toHaveLength(1)
    vi.advanceTimersByTime(8000)
    expect(store.notifications).toHaveLength(0)
  })

  it('keeps an error with an explicit duration of 0 until removed', () => {
    const store = useNotificationStore()
    const id = store.error('Must be read', 0)
    vi.advanceTimersByTime(60000)
    expect(store.notifications).toHaveLength(1)
    store.remove(id)
    expect(store.notifications).toHaveLength(0)
  })

  it('caps the stack, dropping the oldest first', () => {
    const store = useNotificationStore()
    store.error('one', 0)
    store.error('two', 0)
    store.error('three', 0)
    store.error('four', 0)
    expect(store.notifications.map(n => n.message)).toEqual(['two', 'three', 'four'])
  })

  it('is emptied when the auth state is cleared', () => {
    const notifications = useNotificationStore()
    notifications.error('Found 15 errors', 0)
    useAuthStore().clearAuth()
    expect(notifications.notifications).toHaveLength(0)
  })
})
