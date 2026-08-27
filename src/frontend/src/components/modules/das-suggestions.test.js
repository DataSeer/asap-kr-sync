/**
 * The DAS check's row model.
 *
 * The property that matters most: EVERY rule produces a row, including the ones
 * that did not fire. A passed check dropped from the list makes a clean
 * statement and an unchecked statement look identical, which is the one thing
 * this page exists to distinguish.
 */

import { describe, it, expect } from 'vitest'
import {
  buildDasRows, countByStatus, dasMatchesSearch, severityBadge, statusLabel,
  verdictReason, STATUS_ORDER
} from './das-suggestions'

const applies = (over = {}) => ({
  ruleId: 'no_new_dataset',
  severity: 'warning',
  title: 'No new dataset in the Key Resources Table',
  message: 'This table does not include any new data.',
  recommendedText: 'No new primary data were collected in this study.',
  applies: true,
  reason: 'The table lists no new Dataset rows.',
  notApplicableReason: null,
  ...over
})

const passed = (over = {}) => ({
  ruleId: 'datasets_not_mentioned',
  severity: 'info',
  title: 'Dataset resources not mentioned',
  message: 'Your table includes Dataset resources the statement does not mention.',
  recommendedText: null,
  applies: false,
  reason: null,
  notApplicableReason: 'The Availability Statement already refers to the data',
  ...over
})

describe('buildDasRows', () => {
  it('emits a row for a rule that passed, not only for the ones that fired', () => {
    const rows = buildDasRows([passed()])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('Passed')
  })

  it('expands a rule that applies into its explanation and wording', () => {
    const rows = buildDasRows([applies()])
    expect(rows).toHaveLength(2)
    expect(rows[0].isDetail).toBeUndefined()
    expect(rows[1].isDetail).toBe(true)
    expect(rows[1].detail).toContain('does not include any new data')
    expect(rows[1].recommended).toContain('No new primary data')
  })

  it('does not expand a passed rule — there is nothing to act on', () => {
    const rows = buildDasRows([passed()])
    expect(rows.some((r) => r.isDetail)).toBe(false)
  })

  it('puts the rules needing action first', () => {
    const rows = buildDasRows([passed(), applies()])
    expect(rows[0].status).toBe('Action needed')
    expect(rows.at(-1).status).toBe('Passed')
  })

  it('opens and closes every block exactly once', () => {
    const rows = buildDasRows([applies(), passed(), applies({ ruleId: 'no_new_code' })])
    const starts = {}
    const ends = {}
    for (const r of rows) {
      if (r.isGroupStart) starts[r.groupIndex] = (starts[r.groupIndex] || 0) + 1
      if (r.isGroupEnd) ends[r.groupIndex] = (ends[r.groupIndex] || 0) + 1
    }
    expect(Object.values(starts)).toEqual([1, 1, 1])
    expect(Object.values(ends)).toEqual([1, 1, 1])
  })

  it('names a rule that arrived without a title, rather than rendering blank', () => {
    const rows = buildDasRows([passed({ title: null, ruleId: 'some_rule' })])
    expect(rows[0].title).toBe('some_rule')
  })

  it('survives being handed nothing', () => {
    expect(buildDasRows()).toEqual([])
    expect(buildDasRows(null)).toEqual([])
    expect(buildDasRows([])).toEqual([])
  })
})

describe('the verdict, in words and colour', () => {
  it('says which rules need action', () => {
    expect(statusLabel(applies())).toBe('Action needed')
    expect(statusLabel(passed())).toBe('Passed')
    expect(STATUS_ORDER[0]).toBe('Action needed')
  })

  it('colours a rule that applies by its severity', () => {
    expect(severityBadge(applies({ severity: 'warning' }))).toBe('rbadge-warning')
    expect(severityBadge(applies({ severity: 'info' }))).toBe('rbadge-datasets')
  })

  it('does NOT colour a passed check by severity', () => {
    // Amber on a check that passed would make a clean statement look faulty.
    expect(severityBadge(passed({ severity: 'warning' }))).toBe('rbadge-own')
  })

  it('explains a rule that applies with the model\'s reason', () => {
    expect(verdictReason(applies())).toBe('The table lists no new Dataset rows.')
  })

  it('explains a passed rule with why it did not apply', () => {
    expect(verdictReason(passed())).toBe('The Availability Statement already refers to the data')
  })

  it('never returns undefined, so the cell never reads as missing data', () => {
    expect(verdictReason(passed({ notApplicableReason: null }))).toBe('')
    expect(verdictReason(null)).toBe('')
  })
})

describe('counts and search', () => {
  it('counts each side for the filter chips', () => {
    expect(countByStatus([applies(), passed(), passed()]))
      .toEqual({ 'Action needed': 1, Passed: 2 })
  })

  it('counts nothing as nothing', () => {
    expect(countByStatus(null)).toEqual({ 'Action needed': 0, Passed: 0 })
  })

  it('searches the title, the reason and the suggested wording', () => {
    const s = applies()
    expect(dasMatchesSearch(s, 'new dataset')).toBe(true)
    expect(dasMatchesSearch(s, 'no new Dataset rows')).toBe(true)
    expect(dasMatchesSearch(s, 'primary data')).toBe(true)
    expect(dasMatchesSearch(s, 'zzzz')).toBe(false)
  })

  it('matches everything when the box is empty', () => {
    expect(dasMatchesSearch(passed(), '')).toBe(true)
    expect(dasMatchesSearch(passed(), '   ')).toBe(true)
  })
})
