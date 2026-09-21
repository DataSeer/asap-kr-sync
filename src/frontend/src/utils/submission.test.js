import { describe, it, expect } from 'vitest'
import { krtFileBaseName, statusToStep } from './submission'

describe('krtFileBaseName', () => {
  it('names the file after the manuscript id when there is one', () => {
    expect(krtFileBaseName({ id: 'b2bea012', manuscriptId: 'RE2-020529-024-org-D-1', title: 'A paper' }))
      .toBe('KRT_RE2-020529-024-org-D-1')
  })

  it('falls back to a safe form of the title, then to the submission id', () => {
    expect(krtFileBaseName({ id: 'b2bea012', title: 'Neuromodulatory control: energy reserves?' }))
      .toBe('Neuromodulatory_control_energy_reserves')
    expect(krtFileBaseName({ id: 'b2bea012' })).toBe('krt_b2bea012')
    expect(krtFileBaseName(null)).toBe('krt_export')
  })

  it('adds the round as a version suffix on request', () => {
    expect(krtFileBaseName({ manuscriptId: 'PD1-000580' }, { round: 2 })).toBe('KRT_PD1-000580_v2')
    expect(krtFileBaseName({ manuscriptId: 'PD1-000580' }, { round: null })).toBe('KRT_PD1-000580')
  })
})

describe('statusToStep', () => {
  it('maps unknown statuses to step 1', () => {
    expect(statusToStep('nonsense')).toBe(1)
  })
})
