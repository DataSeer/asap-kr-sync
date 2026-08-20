/**
 * The single list of pipeline modules.
 *
 * This list used to exist in three places — the panel's ALL_JOB_TYPES and
 * MODULE_PAGE_TYPES, the pipeline page's HAS_PAGE, the module page's HAS_PAGE —
 * and had already drifted: the pipeline page's comment still said "only
 * krt_grounding has a page so far" above a list of all eleven. They now derive
 * from MODULE_META, so the failure mode changed: a module missing from here is
 * missing from the panel, the pipeline graph AND its own tab strip at once.
 *
 * These tests are mostly about that: no module silently absent, none without a
 * label, and the derived lists genuinely derived rather than re-typed.
 */

import { describe, it, expect } from 'vitest'
import {
  MODULE_META, ALL_JOB_TYPES, MODULE_PAGE_TYPES, STAGE_LABELS,
  hasModulePage, labelFor, purposeFor, stageLabel
} from './module-meta'

/** The pipeline as the server defines it. Kept literal on purpose: if a step is
 *  added server-side, this must be updated deliberately rather than tracking it
 *  automatically and asserting nothing. */
const EXPECTED_MODULES = [
  'markdown_convert', 'orcid_extraction', 'das_extraction',
  'software_detection', 'datasets_detection', 'materials_detection',
  'protocols_detection', 'identifier_detection',
  'krt_grounding', 'pdf_analysis', 'suggestion_generation'
]

describe('the module list', () => {
  it('covers every pipeline step, and nothing else', () => {
    expect(Object.keys(MODULE_META).sort()).toEqual([...EXPECTED_MODULES].sort())
  })

  it('gives every module a label and a purpose a reader can use', () => {
    for (const [jobType, meta] of Object.entries(MODULE_META)) {
      expect(meta.label, `${jobType} has no label`).toBeTruthy()
      expect(meta.label, `${jobType}'s label is its raw key`).not.toBe(jobType)
      expect(meta.purpose?.length, `${jobType}'s purpose is too short to say anything`).toBeGreaterThan(20)
    }
  })

  it('keeps the labels distinct — two modules with one name are unreadable', () => {
    const labels = Object.values(MODULE_META).map((m) => m.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('the derived lists', () => {
  it('ALL_JOB_TYPES carries every module, in the declared order', () => {
    expect(ALL_JOB_TYPES.map((j) => j.type)).toEqual(Object.keys(MODULE_META))
  })

  it('every entry pairs a type with its label', () => {
    for (const { type, label } of ALL_JOB_TYPES) {
      expect(label).toBe(MODULE_META[type].label)
    }
  })

  it('MODULE_PAGE_TYPES is exactly the module list', () => {
    expect([...MODULE_PAGE_TYPES].sort()).toEqual(Object.keys(MODULE_META).sort())
  })

  it('the lists cannot drift apart, because they share a source', () => {
    // The property that replaced three hand-maintained copies.
    expect(ALL_JOB_TYPES.length).toBe(MODULE_PAGE_TYPES.size)
    expect(ALL_JOB_TYPES.length).toBe(EXPECTED_MODULES.length)
  })
})

describe('hasModulePage', () => {
  it('is true for every module', () => {
    for (const jobType of EXPECTED_MODULES) {
      expect(hasModulePage(jobType), jobType).toBe(true)
    }
  })

  it('is false for a step with no page', () => {
    // A new server-side step appears in the graph before its page exists, and a
    // tile linking to an empty page is worse than one that does not link.
    expect(hasModulePage('a_new_step')).toBe(false)
    expect(hasModulePage('das_suggestions')).toBe(false)
  })

  it('is false rather than throwing on nothing', () => {
    expect(hasModulePage(undefined)).toBe(false)
    expect(hasModulePage(null)).toBe(false)
    expect(hasModulePage('')).toBe(false)
  })
})

describe('the display helpers', () => {
  it('label and purpose read from the table', () => {
    expect(labelFor('krt_grounding')).toBe('KRT Grounding')
    expect(purposeFor('krt_grounding')).toBe(MODULE_META.krt_grounding.purpose)
  })

  it('an unknown module shows its raw key rather than nothing', () => {
    // A blank tile is indistinguishable from a broken page.
    expect(labelFor('a_new_step')).toBe('a_new_step')
    expect(purposeFor('a_new_step')).toBe('')
  })

  it('stage labels are named, and an unnamed stage still gets a name', () => {
    STAGE_LABELS.forEach((label, i) => expect(stageLabel(i)).toBe(label))
    expect(stageLabel(STAGE_LABELS.length)).toBe(`Stage ${STAGE_LABELS.length + 1}`)
    expect(stageLabel(99)).toBe('Stage 100')
  })
})
