/**
 * One vocabulary for "what happened to this step?", shared by the processes
 * panel, the pipeline page and every module page.
 *
 * Two bugs motivated it, and both are pinned below:
 *
 *   1. The pipeline page read `job.outcomeState` — a field JobStatusPanel
 *      builds on its OWN view-model and the jobs API never sends. So the check
 *      never fired, and a step whose service had failed rendered as a green
 *      "done". `partial` only made it visible; `fail` had been wrong all along.
 *   2. A module page showed a table with no statement of what state the run was
 *      in, so an empty table read as "found nothing" whether the step had
 *      completed, not started, or been cancelled.
 */
import { describe, it, expect } from 'vitest'
import { describeJobStatus, outcomeStateOf, formatFailReason, partialDetail } from './job-status'

/** A job in the shape the JOBS API returns. */
const apiJob = (status, outcome = null, extra = {}) => ({
  jobType: 'software_detection',
  status,
  ...extra,
  result: outcome ? { service: { outcome } } : {}
})

describe('outcomeStateOf', () => {
  it('reads the API shape, where the state is nested', () => {
    expect(outcomeStateOf(apiJob('complete', { state: 'partial' }))).toBe('partial')
  })

  it('reads the panel view-model shape, where it is flattened', () => {
    expect(outcomeStateOf({ status: 'complete', outcomeState: 'fail' })).toBe('fail')
  })

  it('prefers the nested state when a job somehow carries both', () => {
    const job = { status: 'complete', outcomeState: 'done', result: { service: { outcome: { state: 'partial' } } } }
    expect(outcomeStateOf(job)).toBe('partial')
  })

  it('is null rather than undefined when there is no outcome', () => {
    expect(outcomeStateOf(apiJob('waiting'))).toBe(null)
    expect(outcomeStateOf(null)).toBe(null)
  })
})

describe('describeJobStatus', () => {
  const cases = [
    ['no job at all', null, 'idle', /has not run yet/],
    ['waiting', apiJob('waiting'), 'warn', /waiting for the steps it depends on/i],
    ['queued', apiJob('queued'), 'busy', /queued/i],
    ['processing', apiJob('processing'), 'busy', /running now/i],
    ['needs input', apiJob('pending_input'), 'warn', /waiting for something from you/i],
    ['failed outright', apiJob('failed', null, { errorMessage: 'boom' }), 'bad', /boom/],
    ['complete', apiJob('complete', { state: 'done', source: 'external' }), 'good', /full output/i]
  ]

  for (const [name, job, tone, detail] of cases) {
    it(`describes ${name}`, () => {
      const d = describeJobStatus(job)
      expect(d.tone).toBe(tone)
      expect(`${d.title} ${d.detail}`).toMatch(detail)
      expect(d.label).toBeTruthy()
    })
  }

  it('names the gate a waiting step is held by', () => {
    const d = describeJobStatus(apiJob('waiting', null, { waitingReason: 'krt_validation' }))
    expect(d.detail).toMatch(/Key Resources Table/)
  })

  it('describes a partial run as real AND incomplete', () => {
    const d = describeJobStatus(apiJob('complete', {
      state: 'partial', failReason: 'softcite_failed', externalError: 'Service error'
    }))
    expect(d.tone).toBe('warn')
    expect(d.label).toBe('Partly complete')
    expect(d.detail).toMatch(/real but incomplete/)
    expect(d.detail).toMatch(/Service error/)
  })

  it('does not call a disabled step "done" — nothing was attempted', () => {
    // An empty table under a green "Done" reads as a finding about the
    // manuscript. It is a fact about the configuration.
    const d = describeJobStatus(apiJob('complete', { state: 'done', source: null }))
    expect(d.label).toBe('Disabled')
    expect(d.detail).toMatch(/not a finding about your manuscript/)
  })

  it('says when results are demo data rather than a reading', () => {
    const d = describeJobStatus(apiJob('complete', { state: 'done', source: 'demo' }))
    expect(d.tone).toBe('warn')
    expect(d.title).toMatch(/demo data/)
  })

  it('reports a cancelled step as cancelled, not failed', () => {
    const d = describeJobStatus(apiJob('failed', null, { errorMessage: 'Cancelled by user' }))
    expect(d.label).toBe('Cancelled')
    expect(d.tone).toBe('idle')
  })

  it('always returns something renderable, for every status', () => {
    for (const status of ['waiting', 'queued', 'processing', 'pending_input', 'complete', 'failed', 'cancelled', 'weird']) {
      const d = describeJobStatus(apiJob(status))
      expect(d.label, status).toBeTruthy()
      expect(d.title, status).toBeTruthy()
      expect(['good', 'warn', 'bad', 'busy', 'idle']).toContain(d.tone)
    }
  })
})

describe('formatFailReason / partialDetail', () => {
  it('turns a known reason into a sentence', () => {
    expect(formatFailReason('softcite_failed')).toMatch(/Softcite was unavailable/)
  })

  it('falls back rather than printing a raw token', () => {
    expect(formatFailReason('something_new')).toBe('Process did not produce a result')
  })

  it('builds the partial popup text from either job shape', () => {
    const fromApi = partialDetail(apiJob('complete', {
      state: 'partial', failReason: 'softcite_failed', externalError: 'Service error'
    }))
    const fromPanel = partialDetail({
      outcomeState: 'partial', outcomeFailReason: 'softcite_failed', outcomeExternalError: 'Service error'
    })
    expect(fromApi).toMatch(/Softcite was unavailable/)
    expect(fromApi).toMatch(/Service error/)
    expect(fromPanel).toEqual(fromApi)
  })

  it('is null for anything that is not partial', () => {
    expect(partialDetail(apiJob('complete', { state: 'done' }))).toBe(null)
    expect(partialDetail(null)).toBe(null)
  })
})
