/**
 * What "Restart from here" is going to do, before it does it.
 *
 * The button said "Restart" and did more than that. Restarting a step also
 * resets everything downstream — those results were built from what this step
 * produced — so a click on Markdown Convert threw away eight modules' work with
 * nothing on screen to say so.
 *
 * It also decides what the pipeline re-reads. An input is re-taken only when
 * every step that reads it is being re-run, so "restart the conversion" picks up
 * a manuscript replaced since the round began and "restart one detector"
 * deliberately does not. Someone restarting a single module to pick up their new
 * PDF needs to find that out here, not after the run.
 */
import { describe, it, expect } from 'vitest'
import { downstreamOf, inputsAffected, restartPlan } from './restart-plan'

/** A cut-down pipeline with the shapes that matter: a fan-out and a diamond. */
const NODES = [
  { jobType: 'markdown_convert', dependsOn: [], reads: ['pdf'] },
  { jobType: 'orcid_extraction', dependsOn: [], reads: ['pdf'] },
  { jobType: 'das_extraction', dependsOn: ['markdown_convert'], reads: ['markdown'] },
  { jobType: 'datasets_detection', dependsOn: ['markdown_convert'], reads: ['markdown', 'krt'] },
  { jobType: 'materials_detection', dependsOn: ['markdown_convert'], reads: ['markdown', 'krt'] },
  { jobType: 'krt_grounding', dependsOn: ['datasets_detection', 'materials_detection'], reads: ['markdown', 'krt'] },
  { jobType: 'pdf_analysis', dependsOn: ['krt_grounding'], reads: ['krt'] },
  { jobType: 'suggestion_generation', dependsOn: ['pdf_analysis'], reads: [] }
]

const label = (t) => t.replace(/_/g, ' ')

describe('what a restart carries with it', () => {
  it('follows the chain, not just the direct dependants', () => {
    // The whole reason the dialog exists: three steps beyond the two that name
    // datasets_detection directly.
    expect(downstreamOf(NODES, 'datasets_detection').sort())
      .toEqual(['krt_grounding', 'pdf_analysis', 'suggestion_generation'])
  })

  it('counts a step reached by two paths once', () => {
    // krt_grounding depends on both detectors; restarting the conversion must
    // not list it twice, and must not walk its branch twice either.
    const downstream = downstreamOf(NODES, 'markdown_convert')

    expect(downstream.filter((t) => t === 'krt_grounding')).toHaveLength(1)
    expect(new Set(downstream).size).toBe(downstream.length)
  })

  it('is empty for the last step', () => {
    expect(downstreamOf(NODES, 'suggestion_generation')).toEqual([])
  })

  it('does not follow a sibling — orcid is not downstream of the conversion', () => {
    expect(downstreamOf(NODES, 'markdown_convert')).not.toContain('orcid_extraction')
  })
})

describe('which documents a restart re-reads', () => {
  it('re-reads an input when every step that reads it is re-running', () => {
    // Restarting the conversion carries every markdown reader with it, so the
    // round may take a fresh manuscript.
    const restarting = ['markdown_convert', ...downstreamOf(NODES, 'markdown_convert')]
    const { refreshed } = inputsAffected(NODES, restarting)

    expect(refreshed).toContain('markdown')
  })

  it('keeps an input when some of its readers are not', () => {
    // materials_detection keeps a result built from the frozen markdown, so
    // handing datasets_detection a different one would split the round.
    const restarting = ['datasets_detection', ...downstreamOf(NODES, 'datasets_detection')]
    const { refreshed, kept } = inputsAffected(NODES, restarting)

    expect(kept).toContain('markdown')
    expect(refreshed).not.toContain('markdown')
  })

  it('keeps the PDF unless the steps that read it all restart', () => {
    // orcid_extraction reads the PDF and is downstream of nothing, so no
    // targeted restart can ever release it — only a whole-round run.
    const restarting = ['markdown_convert', ...downstreamOf(NODES, 'markdown_convert')]
    const { kept } = inputsAffected(NODES, restarting)

    expect(kept).toContain('pdf')
  })

  it('releases everything when the whole pipeline restarts', () => {
    const { refreshed, kept } = inputsAffected(NODES, NODES.map((n) => n.jobType))

    expect(refreshed.sort()).toEqual(['krt', 'markdown', 'pdf'])
    expect(kept).toEqual([])
  })
})

describe('the plan handed to the dialog', () => {
  it('names the steps whose results are about to be replaced', () => {
    const plan = restartPlan(NODES, 'datasets_detection', label)

    expect(plan.stepName).toBe('datasets detection')
    expect(plan.alsoReruns).toContain('pdf analysis')
    expect(plan.rerunCount).toBe(4, 'itself plus the three it carries')
  })

  it('says nothing extra when a step carries nothing with it', () => {
    const plan = restartPlan(NODES, 'suggestion_generation', label)

    expect(plan.alsoReruns).toEqual([])
    expect(plan.rerunCount).toBe(1)
  })

  it('labels inputs the way the rest of the app does', () => {
    // The pipeline page's stale note uses the same words. Two names for the
    // same document would read as two documents.
    const plan = restartPlan(NODES, 'markdown_convert', label)

    expect(plan.refreshedInputs).toContain('converted manuscript')
    expect(plan.keptInputs).toContain('manuscript PDF')
  })

  it('survives an empty graph rather than throwing at the user', () => {
    // The panel loads the graph separately and tolerates it failing; the dialog
    // must degrade to "just this step" rather than take the page down.
    const plan = restartPlan([], 'datasets_detection', label)

    expect(plan.alsoReruns).toEqual([])
    expect(plan.refreshedInputs).toEqual([])
  })
})
