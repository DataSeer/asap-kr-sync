/**
 * The Generated KRT's row model.
 *
 * These invariants are what the table's block layout depends on: exactly one
 * row per item opens the block and exactly one closes it. Break either and rows
 * merge into their neighbour or a separator lands mid-item — both of which look
 * like a data problem rather than a CSS one, which is why they are pinned here.
 */

import { describe, it, expect } from 'vitest'
import { buildKrtRows, sourceLabel, sourceBadge, groupBadge, cleanReason } from './generated-krt'

const merged = (name, type, contributors) => ({
  resourceName: name,
  resourceType: type,
  identifier: '',
  sourceUrl: '',
  newReuse: 'reuse',
  detectedBy: contributors
})

const contributor = (source, overrides = {}) => ({
  source,
  originalItem: { resourceName: 'x', resourceType: 'Other', ...overrides }
})

describe('buildKrtRows', () => {
  it('gives a merged item a result row plus one row per contributor', () => {
    const rows = buildKrtRows([
      merged('A', 'Software/code', [contributor('software_detection'), contributor('protocols_detection')])
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0].isResult).toBe(true)
    expect(rows.slice(1).every((r) => !r.isResult)).toBe(true)
  })

  it('gives a single-contributor item no result row — that row IS the result', () => {
    const rows = buildKrtRows([merged('B', 'Datasets', [contributor('datasets_detection')])])
    expect(rows).toHaveLength(1)
    expect(rows[0].isResult).toBeUndefined()
    expect(rows[0].isGroupStart).toBe(true)
    expect(rows[0].isGroupEnd).toBe(true)
  })

  it('still emits a row for an item that records no contributor at all', () => {
    const rows = buildKrtRows([merged('C', 'Other', [])])
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBeNull()
    expect(rows[0].groupSize).toBe(1)
  })

  it('opens and closes every block exactly once', () => {
    const rows = buildKrtRows([
      merged('A', 'Software/code', [contributor('software_detection'), contributor('protocols_detection')]),
      merged('B', 'Datasets', [contributor('datasets_detection')]),
      merged('C', 'Other', [])
    ])
    const starts = {}
    const ends = {}
    for (const r of rows) {
      if (r.isGroupStart) starts[r.groupIndex] = (starts[r.groupIndex] || 0) + 1
      if (r.isGroupEnd) ends[r.groupIndex] = (ends[r.groupIndex] || 0) + 1
    }
    expect(Object.values(starts)).toEqual([1, 1, 1])
    expect(Object.values(ends)).toEqual([1, 1, 1])
  })

  it('takes the result row from the merged item, not from its first contributor', () => {
    // The case that motivated the row: the contributors disagree, and the table
    // has to show which answer was kept.
    const rows = buildKrtRows([
      merged('Pipeline', 'Software/code', [
        contributor('software_detection', { resourceType: 'Software/code' }),
        contributor('protocols_detection', { resourceType: 'Protocol' })
      ])
    ])
    expect(rows[0].resourceType).toBe('Software/code')
    expect(rows[1].resourceType).toBe('Software/code')
    expect(rows[2].resourceType).toBe('Protocol')
  })

  it('numbers groups from 1 and keeps rows of a group together', () => {
    const rows = buildKrtRows([
      merged('A', 'Datasets', [contributor('datasets_detection')]),
      merged('B', 'Datasets', [contributor('datasets_detection'), contributor('identifier_detection')])
    ])
    expect(rows[0].groupNumber).toBe(1)
    expect(rows.filter((r) => r.groupIndex === 1)).toHaveLength(3)
  })

  it('survives being handed nothing', () => {
    expect(buildKrtRows()).toEqual([])
    expect(buildKrtRows(null)).toEqual([])
    expect(buildKrtRows([])).toEqual([])
  })
})

describe('labels and colours', () => {
  it('names every source it can appear with, including the ones that are not detectors', () => {
    expect(sourceLabel('materials_detection')).toBe('Materials')
    expect(sourceLabel('author_krt')).toBe('Author KRT')
    expect(sourceLabel('krt_grounding')).toBe('Grounding')
    expect(sourceLabel('pdf_analysis')).toBe('Consolidation')
  })

  it('falls back to the raw key rather than rendering nothing', () => {
    expect(sourceLabel('a_new_module')).toBe('a_new_module')
  })

  it('gives a detector the colour of what it finds', () => {
    expect(sourceBadge('datasets_detection')).toBe('rbadge-datasets')
    expect(sourceBadge('materials_detection')).toBe('rbadge-materials')
    expect(groupBadge('Lab Materials')).toBe('rbadge-materials')
    expect(groupBadge('Datasets')).toBe('rbadge-datasets')
  })

  it('gives anything cross-category or unknown the neutral colour', () => {
    expect(sourceBadge('identifier_detection')).toBe('rbadge-neutral')
    expect(sourceBadge('something_else')).toBe('rbadge-neutral')
    expect(groupBadge('Nonsense')).toBe('rbadge-neutral')
  })

  it('marks the author-carried row as the document\'s own, not as a finding', () => {
    expect(sourceBadge('author_krt')).toBe('rbadge-own')
  })
})

describe('cleanReason', () => {
  it('strips the internal candidate refs the model was told not to mention', () => {
    expect(cleanReason('merged duplicates (refs 0 and 4)')).toBe('merged duplicates')
    expect(cleanReason('kept ref 7')).toBe('kept')
  })

  it('replaces a raw row UUID with words a reader can use', () => {
    const uuid = 'a3d12f45-1234-4321-8888-abcdefabcdef'
    expect(cleanReason(`matched row ${uuid}`)).toBe('matched the matching author row')
    expect(cleanReason(`kept (row ${uuid})`)).toBe('kept')
  })

  it('leaves an ordinary reason alone', () => {
    expect(cleanReason('Named in the methods section')).toBe('Named in the methods section')
  })

  it('returns an empty string for nothing, never undefined', () => {
    expect(cleanReason(null)).toBe('')
    expect(cleanReason(undefined)).toBe('')
  })
})
