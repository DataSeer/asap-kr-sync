/**
 * The AI Suggestions decision log, as the table consumes it.
 *
 * Two properties matter here: every decision must produce at least one visible
 * row (a decision that renders nothing is a suggestion the curator never sees),
 * and a change must show both sides so the diff has something to compare.
 */

import { describe, it, expect } from 'vitest'
import {
  decisionLabel, decisionType, decisionMatchesSearch, buildDecisionRows, DECISION_ORDER
} from './suggestion-decisions'

const row = (over = {}) => ({
  resourceType: 'Antibody', resourceName: 'anti-TagFP', source: 'Evrogen',
  identifier: 'RRID:AB_2313584', newReuse: 'reuse', ...over
})

describe('decisionLabel', () => {
  it('reads both shapes: the decision log and an older raw suggestion', () => {
    expect(decisionLabel({ action: 'add' })).toBe('Add')
    expect(decisionLabel({ type: 'add_row' })).toBe('Add')
    expect(decisionLabel({ action: 'edit' })).toBe('Update')
    expect(decisionLabel({ type: 'delete_row' })).toBe('Remove')
    expect(decisionLabel({ action: 'skip' })).toBe('Skip')
  })

  it('never renders blank for an action it does not know', () => {
    expect(decisionLabel({ action: 'invented' })).toBe('invented')
    expect(decisionLabel({})).toBe('—')
  })

  it('orders what changes before what did not', () => {
    expect(DECISION_ORDER.indexOf('Add')).toBeLessThan(DECISION_ORDER.indexOf('Skip'))
    expect(DECISION_ORDER.indexOf('Remove')).toBeLessThan(DECISION_ORDER.indexOf('Skip'))
  })
})

describe('decisionType', () => {
  it("prefers the author's row, since that is the table being curated", () => {
    expect(decisionType({ authorRow: row(), generatedRow: row({ resourceType: 'Datasets' }) }))
      .toBe('Antibody')
  })

  it('falls back to the generated row for an addition', () => {
    expect(decisionType({ generatedRow: row({ resourceType: 'Datasets' }) })).toBe('Datasets')
  })

  it('returns an empty string rather than undefined when neither exists', () => {
    expect(decisionType({})).toBe('')
  })
})

describe('buildDecisionRows', () => {
  it('shows both sides of an update, author first', () => {
    const rows = buildDecisionRows([{
      action: 'update',
      authorRow: row({ identifier: 'RRID:AB_1' }),
      generatedRow: row({ identifier: 'RRID:AB_2' }),
      changes: { identifier: true }
    }])
    expect(rows).toHaveLength(2)
    expect(rows[0].side).toBe('author')
    expect(rows[1].side).toBe('generated')
    expect(rows[0].isGroupStart).toBe(true)
    expect(rows[1].isGroupStart).toBe(false)
    expect(rows.every((r) => r.changes.identifier)).toBe(true)
  })

  it('shows only the proposal for an addition — there is no author row yet', () => {
    const rows = buildDecisionRows([{ action: 'add', generatedRow: row() }])
    expect(rows).toHaveLength(1)
    expect(rows[0].side).toBe('generated')
  })

  it("shows only the author's row for a skip", () => {
    const rows = buildDecisionRows([{ action: 'skip', authorRow: row(), generatedRow: row() }])
    expect(rows).toHaveLength(1)
    expect(rows[0].side).toBe('author')
  })

  it('never drops a decision, even one carrying neither row', () => {
    const rows = buildDecisionRows([{ action: 'skip', resourceName: 'Something' }])
    expect(rows).toHaveLength(1)
    expect(rows[0].cells.resourceName).toBe('Something')
  })

  it('labels every row it emits, so the decision column is never blank', () => {
    const rows = buildDecisionRows([
      { action: 'update', authorRow: row(), generatedRow: row(), changes: {} },
      { action: 'add', generatedRow: row() }
    ])
    expect(rows.every((r) => r.decisionLabel)).toBe(true)
  })

  it('numbers groups so two decisions never share one', () => {
    const rows = buildDecisionRows([
      { action: 'add', generatedRow: row() },
      { action: 'add', generatedRow: row() }
    ])
    expect(rows[0].groupIndex).toBe(0)
    expect(rows[1].groupIndex).toBe(1)
  })

  it('survives being handed nothing', () => {
    expect(buildDecisionRows()).toEqual([])
    expect(buildDecisionRows(null)).toEqual([])
  })
})

describe('decisionMatchesSearch', () => {
  it('searches both rows, since a name may be on only one of them', () => {
    const d = { action: 'update', authorRow: row({ resourceName: 'old name' }), generatedRow: row({ resourceName: 'new name' }) }
    expect(decisionMatchesSearch(d, 'old name')).toBe(true)
    expect(decisionMatchesSearch(d, 'new name')).toBe(true)
  })

  it('searches the reason too', () => {
    expect(decisionMatchesSearch({ action: 'skip', reason: 'already correct' }, 'already')).toBe(true)
  })

  it('matches everything when the query is empty', () => {
    expect(decisionMatchesSearch({ action: 'skip' }, '')).toBe(true)
  })

  it('does not match an unrelated term', () => {
    expect(decisionMatchesSearch({ action: 'skip', authorRow: row() }, 'zzzz')).toBe(false)
  })
})
