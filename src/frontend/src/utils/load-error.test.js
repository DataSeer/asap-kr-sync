import { describe, it, expect } from 'vitest'
import { describeLoadError } from './load-error'

describe('describeLoadError', () => {
  it('does not offer a retry for a 403 — the answer will not change', () => {
    expect(describeLoadError({ response: { status: 403 } }))
      .toEqual({ message: 'You do not have access to this submission.', retryable: false })
  })

  it('does not offer a retry for a 404', () => {
    expect(describeLoadError({ response: { status: 404 } }).retryable).toBe(false)
  })

  it('prefers the server\'s own message', () => {
    const err = { response: { status: 500, data: { error: 'Database unavailable' } }, message: 'Request failed' }
    expect(describeLoadError(err)).toEqual({ message: 'Database unavailable', retryable: true })
  })

  it('falls back to the transport error when the server said nothing', () => {
    expect(describeLoadError({ message: 'Network Error' }))
      .toEqual({ message: 'Network Error', retryable: true })
  })

  it('always yields a message, even for a thrown nothing', () => {
    const described = describeLoadError(undefined)
    expect(described.message).toBe('The server did not respond.')
    expect(described.retryable).toBe(true)
  })
})
