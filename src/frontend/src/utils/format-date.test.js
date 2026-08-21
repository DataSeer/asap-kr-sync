// @vitest-environment happy-dom
/**
 * The two date formats, and the case every copy of this got wrong.
 *
 * There were six `formatDate` functions across the views, already drifted into
 * two behaviours, and all six rendered a missing date as the literal string
 * "Invalid Date" — which reads to a user like a data problem rather than an
 * absent value.
 */

import { describe, it, expect } from 'vitest'
import { formatDate, formatDateTime } from './format-date'

const MOMENT = '2026-08-20T14:05:00Z'

describe('formatDate', () => {
  it('names the month rather than numbering it', () => {
    // "8/20/26" and "20/8/26" are the same string to a parser and opposite
    // dates to a reader, depending on which side of an ocean they are on.
    expect(formatDate(MOMENT)).toBe('20 Aug 2026')
  })

  it('accepts a Date as readily as a string', () => {
    expect(formatDate(new Date(MOMENT))).toBe('20 Aug 2026')
  })

  it('shows a dash for a missing date, never "Invalid Date"', () => {
    for (const value of [null, undefined, '', 'not a date', NaN]) {
      expect(formatDate(value)).toBe('—')
    }
  })
})

describe('formatDateTime', () => {
  it('carries the time as well as the day', () => {
    // Two rows created the same day are otherwise indistinguishable, and the
    // order they happen to be listed in is the only clue which came first.
    expect(formatDateTime(MOMENT)).toMatch(/^20 Aug 2026, \d{2}:\d{2}$/)
  })

  it('uses a 24-hour clock', () => {
    expect(formatDateTime(MOMENT)).not.toMatch(/am|pm/i)
  })

  it('shows a dash for a missing date too', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('nonsense')).toBe('—')
  })

  it('starts with exactly what formatDate would render', () => {
    // The two must not drift apart again — that is what six copies did.
    expect(formatDateTime(MOMENT).startsWith(formatDate(MOMENT))).toBe(true)
  })
})
