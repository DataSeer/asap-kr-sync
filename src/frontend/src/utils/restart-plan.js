/**
 * What "Restart from here" is actually going to do.
 *
 * The button used to say "Restart" and do more than that: restarting one step
 * resets everything downstream of it, because those results were built from
 * what this step produced. A user clicking it on Markdown Convert was throwing
 * away eight modules' work, and nothing on screen said so.
 *
 * It can also change what the pipeline reads. An input is re-taken only when
 * every step that reads it is being re-run, so restarting the conversion picks
 * up a manuscript replaced since the round began, while restarting one detector
 * deliberately keeps the document its siblings used. Those are different
 * actions and the dialog should not describe them the same way.
 *
 * Pure functions over the pipeline graph — no component state, so the rule can
 * be read and tested on its own.
 */

/** Human names for the frozen inputs, matching the pipeline page. */
const INPUT_LABELS = {
  pdf: 'manuscript PDF',
  markdown: 'converted manuscript',
  krt: 'Key Resources Table'
}

/**
 * Every step that depends on `jobType`, directly or through another step.
 *
 * @param {Array<{jobType: string, dependsOn: string[]}>} nodes
 * @param {string} jobType
 * @returns {string[]}
 */
export function downstreamOf(nodes, jobType) {
  const consumers = new Map()
  for (const node of nodes) {
    for (const dep of node.dependsOn || []) {
      if (!consumers.has(dep)) consumers.set(dep, [])
      consumers.get(dep).push(node.jobType)
    }
  }

  const found = new Set()
  const queue = [jobType]
  while (queue.length) {
    for (const next of consumers.get(queue.shift()) || []) {
      // The guard is what stops a diamond — two detectors feeding grounding —
      // from walking the same branch twice, and would stop a cycle dead if a
      // bad edit ever introduced one.
      if (found.has(next)) continue
      found.add(next)
      queue.push(next)
    }
  }
  return [...found]
}

/**
 * Which frozen inputs a restart will re-read.
 *
 * An input is re-taken only when EVERY step that reads it is in the restart.
 * Otherwise the steps that are not re-running keep results built from the
 * frozen one, and handing the restarted step a different document would split
 * the round.
 *
 * @param {Array<{jobType: string, reads?: string[]}>} nodes
 * @param {string[]} restarting - the step plus its downstream
 * @returns {{ refreshed: string[], kept: string[] }} input kinds
 */
export function inputsAffected(nodes, restarting) {
  const inRestart = new Set(restarting)
  const readers = new Map()
  for (const node of nodes) {
    for (const kind of node.reads || []) {
      if (!readers.has(kind)) readers.set(kind, [])
      readers.get(kind).push(node.jobType)
    }
  }

  const refreshed = []
  const kept = []
  for (const [kind, steps] of readers) {
    (steps.every((step) => inRestart.has(step)) ? refreshed : kept).push(kind)
  }
  return { refreshed, kept }
}

/**
 * The whole plan, ready to render.
 *
 * Takes one step or several. Several is not a loop over one: the steps share
 * downstream work — five detectors all feed grounding — so the union is what
 * gets replaced, and it is smaller than the sum. Told step by step, a user
 * restarting three detectors would read "grounding will re-run" three times and
 * reasonably conclude it runs three times.
 *
 * @param {Array<object>} nodes - the pipeline graph
 * @param {string|string[]} jobTypes - the step(s) being restarted
 * @param {(jobType: string) => string} label - job type → display name
 * @returns {object}
 */
export function restartPlan(nodes, jobTypes, label = (t) => t) {
  const selected = [...new Set(Array.isArray(jobTypes) ? jobTypes : [jobTypes])]
  const selectedSet = new Set(selected)

  // The union of what they carry, minus the selection itself — those are being
  // run, not discarded, and listing them as replaced would say the opposite.
  const downstream = new Set()
  for (const jobType of selected) {
    for (const dep of downstreamOf(nodes, jobType)) {
      if (!selectedSet.has(dep)) downstream.add(dep)
    }
  }

  const restarting = [...selected, ...downstream]
  const { refreshed, kept } = inputsAffected(nodes, restarting)

  return {
    /** The single step, when there is one — the dialog words itself differently. */
    jobType: selected.length === 1 ? selected[0] : null,
    jobTypes: selected,
    stepName: selected.length === 1
      ? label(selected[0])
      : `${selected.length} steps`,
    /** Named so the user can see exactly whose results are being discarded. */
    selectedNames: selected.map(label),
    alsoReruns: [...downstream].map(label),
    rerunCount: restarting.length,
    /** Documents this restart will take fresh copies of. */
    refreshedInputs: refreshed.map((kind) => INPUT_LABELS[kind] || kind),
    /**
     * Documents it will keep using. Worth saying: a user restarting one
     * detector to "pick up my new PDF" is about to be disappointed, and this is
     * where they find that out rather than after the run.
     */
    keptInputs: kept.map((kind) => INPUT_LABELS[kind] || kind)
  }
}

export { INPUT_LABELS }
